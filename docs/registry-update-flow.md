# Registry Update Detection Flow

This document describes how BridgePort detects container image updates from registries, resolves tag families, and correlates tags by digest.

## Update Check Flow

```mermaid
sequenceDiagram
    participant S as Scheduler (30min)
    participant DB as Database
    participant R as Registry Client
    participant D as detectUpdate()

    S->>DB: Fetch ContainerImages with registryConnectionId
    S->>DB: Group by registry connection

    loop For each registry
        S->>DB: Decrypt registry credentials
        S->>R: Create client (DO / DockerHub / Generic V2)

        loop For each image
            R->>R: client.listTags(repo)
            R-->>S: All registry tags
            S->>D: detectUpdate(imageId, currentTag, deployedDigest, allTags)

            D->>D: findLatestInFamily(allTags, currentTag)
            Note over D: getTagFamily() → determine family<br/>filterTagsByFamily() → same family only<br/>Sort by updatedAt, fallback to version compare

            alt Version upgrade (different tag name)
                D->>D: Compare digests if available
                Note over D: Empty digest → assume update<br/>Different digest → update available
            else Rolling tag (same tag name)
                alt Registry returned digest
                    D->>D: Compare with deployedDigest or history
                else No digest from registry
                    D->>D: Can't determine → no false positive
                end
            end

            D->>D: findCompanionTag() if digest available
            Note over D: Resolve rolling tag → concrete build tag<br/>(e.g., "latest" → "20260223-30a4f0b")

            D->>DB: Update ContainerImage (latestTag, latestDigest, updateAvailable)

            opt autoUpdate enabled
                S->>S: buildDeploymentPlan() → executePlan()
            end
        end
    end
```

## Tag Family & Digest Correlation

### Tag Families

Tags are grouped into "families" based on their suffix. Only tags in the same family are compared for updates:

```mermaid
flowchart LR
    subgraph "Version Tags"
        A["2.9.0-alpine"] -->|family: -alpine| F1["-alpine family"]
        B["2.10.0-alpine"] -->|family: -alpine| F1
        C["3.0.0-alpine"] -->|family: -alpine| F1

        D["v1.0.0"] -->|"family: (empty)"| F2["bare version family"]
        E["v2.0.0"] -->|"family: (empty)"| F2
        F["3.0.0"] -->|"family: (empty)"| F2
    end

    subgraph "Rolling Tags"
        G["latest"] -->|family: =latest| F3["=latest family"]
        H["stable"] -->|family: =stable| F4["=stable family"]
    end
```

### Digest Correlation (Companion Tags)

Rolling tags like "latest" point to the same image as a concrete build tag. BridgePort resolves this via digest matching:

```mermaid
flowchart TD
    L["latest<br/>digest: sha256:abc123"] --> |same digest| B["20260223-30a4f0b<br/>digest: sha256:abc123"]
    L --> |companion resolved| R["latestTag = 20260223-30a4f0b"]

    S["stable<br/>digest: sha256:def456"] --> |same digest| V["v2.1.0<br/>digest: sha256:def456"]
    S --> |companion resolved| R2["latestTag = v2.1.0"]

    N["latest<br/>digest: (empty)"] --> |no digest| X["Cannot resolve companion"]
    X --> |conservative| R3["No update reported"]
```

## Registry Client Differences

| Feature | DO Registry | Docker Hub | Generic V2 |
|---------|-------------|------------|------------|
| **Tag listing** | DO API response | Hub API response | `/v2/{repo}/tags/list` + manifest HEADs |
| **Digest source** | API field | API field (may be empty) | `Docker-Content-Digest` header |
| **Size available** | Yes | Yes | No (always 0) |
| **Real timestamps** | Yes | Yes | No (set to current time) |
| **Auth method** | Bearer token | Token exchange / Basic | Basic auth |
| **Manifest types** | Standard | Standard | Multi-Accept (v2 + OCI + manifest list) |

### Empty Digest Handling

When a registry doesn't return a digest:

- **Version tags**: Update detection falls back to tag name comparison. If a newer version exists in the same family, it's reported as an update.
- **Rolling tags**: Cannot determine if the image changed. Returns `hasUpdate: false` to avoid false positives (the "latest available" badge problem).
- **Companion resolution**: Skipped entirely — requires a valid digest to match across tags.
- **UI display**: Shows "unavailable" in muted text instead of a misleading dash.

### Synthetic Timestamps

Generic V2 registries don't provide real timestamps — all tags get `new Date().toISOString()` as `updatedAt`. When this is detected:

- **Sorting**: Falls back to semver-aware version comparison (`compareVersionTags()`) instead of timestamp ordering.
- **UI display**: Shows "—" for the Updated column instead of a misleading "less than a minute ago".
