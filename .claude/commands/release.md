---
allowed-tools: Bash, Read, Write, AskUserQuestion
description: Draft release notes, tag, and publish a new BRIDGEPORT release
---

# Cut a BRIDGEPORT release

Drive an interactive release: gather context, draft curated release notes with the user, then push an annotated git tag. The `release.yml` workflow takes it from there (builds the image with semantic-version tags and creates the GitHub Release using the tag's message verbatim).

Branding: write **BridgePort** in user-facing notes (not "bridgeport" or "Bridgeport").

## Step 1 — Pre-flight checks

Run all four and abort with a clear message if any fail:

```bash
# Branch + clean tree
git rev-parse --abbrev-ref HEAD                # must be "master"
git status --porcelain                         # must be empty

# Up-to-date with origin/master
git fetch origin master
git rev-list HEAD..origin/master --count       # must be 0

# Last test.yml run on master is green
gh run list --workflow=test.yml --branch=master --limit=1 \
  --json conclusion,headSha,url --jq '.[0]'
```

If tests are not green, stop and tell the user — do **not** release on red.

## Step 2 — Detect last release

```bash
LAST_TAG=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo "")
```

If empty, this is the first release — diff against the initial commit instead.

## Step 3 — Gather change context

```bash
# Commits since last tag (excluding merge commits)
git log "${LAST_TAG}..HEAD" --pretty=format:'%h %s' --no-merges

# Files touched, by area
git diff "${LAST_TAG}..HEAD" --stat

# Migrations added (always call these out — see CLAUDE.md golden rule)
git diff --name-only "${LAST_TAG}..HEAD" -- prisma/migrations/
```

For each PR referenced as `(#N)` in commit subjects, fetch the title/body/labels for richer context:

```bash
gh pr view <N> --json title,body,labels,author
```

Read PR bodies to understand *why* each change was made — that's what release notes should communicate.

## Step 4 — Draft release notes

GitHub renders the annotated tag message as markdown on the Release page. Write notes that are **human-readable and easy to skim**, not a flat dump of bullets. Operators read this when deciding whether to upgrade in production — they should be able to find what they need in seconds.

### Format recipe

Use this structure. Omit any section that's empty. Scale it down for tiny patch releases (a single-fix patch release doesn't need every section — a short "What's new" paragraph + one Fixes section is fine).

````markdown
## What's new

<2-3 sentence summary naming the headline changes — what's the elevator pitch of this release? Mention if migrations apply automatically.>

---

## Action required before upgrading

Skip this section if you don't use these features.

### 1. <Short title of the breaking change>

<What changed, who it affects, what they need to do. Use prose + bullets, not just bullets.>

```yaml
# Before / After config snippet if helpful
```

(#PR)

### 2. <Next breaking change…>

---

## Database migrations

<Lead sentence: how many migrations, automatic vs manual.>

- **`<migration_directory_name>`** — what it changes for operators (schema additions, data transformations, etc.) (#PR)

---

## Features

### <Feature name> (#PR)

<Prose paragraph explaining what it enables and why operators care.>

- Bullet for concrete capability / behavior
- Bullet for UI surface or API endpoint added
- Bullet for important caveat

### <Next feature…>

---

## API changes

Required in every release (see [API Stability Policy](../../docs/api-stability.md)). Say "None" when there are no HTTP API-surface changes. Split into Added / Deprecated / Removed; omit empty subsections.

### Added

- New `GET /api/...` endpoint / new optional field on `<endpoint>` (#PR)

### Deprecated

- `<field>` on `<endpoint>` — use `<replacement>` instead. Removal target: <next major>. Also flag `deprecated: true` in the OpenAPI spec and add a row to the "Current deprecations" table in `docs/api-stability.md`. (#PR)

### Removed

- `<surface>` (deprecated in <version>) is gone — migrate to `<replacement>`. (#PR)

---

## Improvements

<Group related improvements under H3 subheadings when there are several from the same area (e.g. "Config scan" with three sub-items). Use a flat bullet list only when items are independent.>

### <Improvement area> (#PR)

Prose + bullets.

---

## Fixes

### <Short title> (#PR)

What was broken, what's fixed, user-visible symptom.

---

## Security

- **CVE / advisory ID** — one-paragraph explanation of the issue, the fix, and the scope (dev-only vs prod). (#PR)
- **<Other hardening>** — what changed and why it matters. (#PR)

---

## Under the hood

<Use this section for refactors, dep bumps, CI changes — anything that's not directly user-visible but worth mentioning. Group dependabot bumps as one paragraph + PR refs, don't enumerate each one.>

### <Notable internal change> (#PR)

Short paragraph.

### Other notable bumps

- **<thing>** — old → new version (#PR)
- Dependency-group bumps: #N, #N, #N

---

## Documentation

<Only if there are notable doc additions. Otherwise fold doc updates into the related feature/fix.>
````

### Authoring guidelines

- **Lead with the user-visible effect**, not the implementation detail. "External scripts that minted tokens need updating" beats "removed `POST /api/auth/tokens` endpoint".
- **Front-load action-required items.** Put "Action required before upgrading" right after "What's new" so operators see breaking changes before deciding to upgrade.
- **Group related items under named H3 subheadings.** Three improvements to the config scanner should be one `### Config scanner` block, not three parallel bullets.
- **Use fenced code blocks** for before/after config, migration commands, or anything copy-pasteable. Indent inside `yaml`, `bash`, `ts`, etc. for syntax highlighting.
- **Use horizontal rules (`---`)** between top-level `##` sections for visual rhythm.
- **Always link PRs as `(#N)`** at the end of the relevant paragraph/heading. GitHub auto-links them.
- **Skip noise** from top-level sections (formatting-only commits, dependabot bumps with no functional change). Group dependabot in "Under the hood" as one line + PR refs.
- **Migrations get their own top-level section** because BridgePort's upgrade story (CLAUDE.md golden rule) makes them user-visible — call out what each migration changes for operators.
- **No emojis** unless the user explicitly asks for them.

## Step 5 — Iterate with the user

Show the draft. Ask if they want changes. Apply edits. Re-show. Stop when they say ship.

## Step 6 — Pick the version

Compute `LAST_VERSION=${LAST_TAG#v}` and propose a default bump:

- **major** — anything in `## Action required before upgrading`, or a `## API changes → Removed` entry (breaking wire-format changes ship major-only; see `docs/api-stability.md`)
- **minor** — anything in `## Features` or `## Database migrations`, or `## API changes → Added` / `Deprecated` entries
- **patch** — only `## Fixes`, `## Security`, `## Documentation`, `## Under the hood`

Use AskUserQuestion to confirm (patch / minor / major / prerelease). For prerelease, ask for the suffix (e.g. `rc.1`, `beta.2`) and append to the next minor: `1.2.0-rc.1`.

Show the proposed tag (e.g. `v1.2.0`) and the final notes side-by-side.

## Step 7 — Final confirmation

Print the exact commands that will run and use AskUserQuestion to confirm. Example:

```
About to:
  1. git tag -a v1.2.0 -F /tmp/bridgeport-release-notes.md
  2. git push origin v1.2.0

This triggers .github/workflows/release.yml, which will:
  - Build the image
  - Push :v1.2.0, :1.2.0, :1.2, :1, :stable, :latest to ghcr.io
  - Create the GitHub Release with these notes

Proceed?
```

## Step 8 — Tag and push

Write the final notes to a temp file and use it with `-F` so the message is preserved exactly.

**CRITICAL: pass `--cleanup=verbatim`.** Without it, `git tag` strips every line that starts with `#` as a comment — which silently deletes all `##`/`###` markdown headers from the notes (this bit v2.0.0 and v2.1.0). `release.yml` reads the tag message verbatim to create the GitHub Release, so missing headers ship to users. `--cleanup=verbatim` keeps the message exactly as written.

```bash
cat > /tmp/bridgeport-release-notes.md <<'EOF'
<final notes>
EOF

git tag -a "v${VERSION}" --cleanup=verbatim -F /tmp/bridgeport-release-notes.md
git push origin "v${VERSION}"
```

Sanity-check the headers survived before pushing — `git show "v${VERSION}" --no-patch` should still show the `##` lines. If you forgot the flag and already pushed, don't delete/re-push the tag: fix forward with `gh release edit "v${VERSION}" --notes-file <file>` once `release.yml` has created the Release.

## Step 9 — Close the matching milestone

If a milestone exists whose title exactly matches `${VERSION}` (the version without the `v` prefix — milestones are named `2.2.0`, not `v2.2.0`), its work just shipped, so close it. Skip silently when there's no match (most releases won't have one).

```bash
MILESTONE_NUMBER=$(gh api repos/:owner/:repo/milestones --jq ".[] | select(.title == \"${VERSION}\") | .number")
if [ -n "$MILESTONE_NUMBER" ]; then
  gh api "repos/:owner/:repo/milestones/${MILESTONE_NUMBER}" -X PATCH -f state=closed >/dev/null \
    && echo "Closed milestone ${VERSION}"
fi
```

Note any still-open issues on the milestone in the final report — closing the milestone doesn't close them, and they likely slipped the release.

## Step 10 — Report

Tell the user where to watch the workflow and where the release will appear:

```bash
gh run list --workflow=release.yml --limit=1 --json url,status --jq '.[0]'
```

The GitHub Release URL will be:
`https://github.com/<owner>/<repo>/releases/tag/v${VERSION}`

## Notes

- `release.yml` reads the annotated tag message verbatim, so what you write in the notes file is what users see on GitHub.
- Prereleases (version contains `-`) only publish `:v{version}` and `:{version}` — never `:latest`, `:stable`, major, or minor tags.
- If the workflow fails after the tag has been pushed, fix forward (cut the next patch). Do **not** delete and re-push tags — image tags pointing at deleted refs are confusing.
