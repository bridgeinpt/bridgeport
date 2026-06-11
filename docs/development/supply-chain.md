# Supply Chain Hardening

BRIDGEPORT applies a few defensive defaults to reduce the blast radius of compromised npm packages (typosquats, malicious post-install scripts, and freshly-published-then-yanked versions). This page explains the defaults, the trade-offs, and the escape hatches.

## Requirements

You need **pnpm 11 or newer** (`pnpm --version`). The supply-chain settings below live in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) and rely on pnpm 11 semantics:

- `allowBuilds` (the pnpm 11 successor to v10's `onlyBuiltDependencies`) — the explicit allowlist of packages permitted to run install/build scripts.
- `minimumReleaseAge` — the release-age cooldown, measured in **minutes**.

Install pnpm with `npm install -g pnpm` (or, on Node.js < 25, `corepack enable`). The repo pins its exact pnpm version via the `packageManager` field in [`package.json`](../../package.json). CI uses [`pnpm/action-setup`](https://github.com/pnpm/action-setup) to install the same version — see [`.github/workflows/test.yml`](../../.github/workflows/test.yml).

## Defaults

[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) sets:

```yaml
allowBuilds:
  better-sqlite3: true
  '@prisma/engines': true
  prisma: true
  ssh2: true
  cpu-features: true
  esbuild: true
  protobufjs: true
  msw: true

minimumReleaseAge: 1440
```

### Lifecycle-script blocking (`allowBuilds`)

npm runs `preinstall`, `install`, and `postinstall` lifecycle scripts from every package in the dependency tree by default. A single compromised transitive dependency can therefore execute arbitrary code on a developer machine or in CI the moment dependencies are installed.

pnpm flips this: it **blocks all dependency build scripts by default**. The `allowBuilds` map is the explicit allowlist — each package is set to `true` (allowed to run its scripts) or `false` (denied). Anything not listed stays blocked. By default pnpm only *warns* about a blocked build (the install still succeeds), so we additionally set `strictDepBuilds: true` — an unlisted package that *wants* to build then fails the install loudly rather than silently shipping a broken/unbuilt module.

This replaces the old npm `.npmrc` `ignore-scripts=true` (plus the manual `npm rebuild` dance): allowlisted native modules build automatically at install time, so there is **no separate rebuild step** in CI or the Dockerfile.

> **pnpm 11 note:** v11 removed `onlyBuiltDependencies`, `neverBuiltDependencies`, `ignoredBuiltDependencies`, `onlyBuiltDependenciesFile`, and `ignoreDepScripts`, folding them all into the single `allowBuilds` map. If you copy config from an older pnpm guide, translate `onlyBuiltDependencies: [foo]` into `allowBuilds: { foo: true }`.

### Release-age cooldown (`minimumReleaseAge: 1440`)

A version published in the last 24 hours is statistically the most likely to be a malicious release (compromised maintainer account, supply chain attack, accidental publish). `minimumReleaseAge` tells pnpm to skip versions younger than the given age (in **minutes**) when resolving ranges, giving the wider community time to spot and yank a bad release. `1440` minutes = 1 day, matching the old npm `min-release-age=1` (npm measured this in days). pnpm 11 already defaults to 1440; we pin it explicitly so the intent is documented.

This does not lock the lockfile — once a version is older than the cooldown it will be picked up normally on the next install.

## Allowed native / build-script modules

These dependencies need their build scripts to be usable, which is why they appear in `allowBuilds`:

- `better-sqlite3` — primary SQLite driver; compiles (or downloads a prebuilt) native binding at install time. Because it is allowlisted, a plain `pnpm install` produces a working binding with no manual rebuild.
- `@prisma/engines` / `prisma` — Prisma fetches query-engine binaries during install/`prisma generate`. We also invoke `prisma generate` explicitly in the Dockerfile and CI.
- `ssh2` / `cpu-features` — `ssh2` uses an optional native crypto accelerator (`cpu-features`). The pure-JS fallback works everywhere; the native acceleration is only used when present.
- `esbuild` — links its platform-specific prebuilt binary on install. Vite drives esbuild.
- `protobufjs` — runs build-time codegen (pulled in transitively via `dockerode`).
- `msw` — places its service-worker asset on install (dev/test only).

## Developer workflow

### A package needs build scripts

If you add a new dependency that has a legitimate build/post-install step, add it to the `allowBuilds` map in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) with a `true` value, then reinstall:

```yaml
allowBuilds:
  # ...existing entries...
  my-native-dep: true
```

```bash
pnpm install
```

If you're unsure which packages want to build, run `pnpm install` and pnpm will list the ones it blocked, or use `pnpm approve-builds` interactively to pick them (it writes the result into `allowBuilds`).

### Emergency: bypassing the cooldown

If you genuinely need to pull a brand-new version (CVE patch released minutes ago, hotfix you authored yourself, etc.), override the cooldown for a single install:

```bash
pnpm install --config.minimumReleaseAge=0 <pkg>
```

Do not change the `minimumReleaseAge` default. The cooldown exists precisely so that the urgent-feeling case gets a second pair of eyes.

## Dependabot cooldown

[`.github/dependabot.yml`](../../.github/dependabot.yml) applies a matching cooldown to each ecosystem so Dependabot does not open a PR for a version that pnpm would refuse to install locally. The single npm-ecosystem entry (which covers the whole pnpm workspace via the root `pnpm-lock.yaml`) uses 3–7 days depending on semver bump; Docker, GitHub Actions, and Go modules use a flat 3-day cooldown.

Security updates bypass Dependabot's cooldown automatically — a CVE patch will still open immediately.

## Related

- [Setup](setup.md) — first-time install instructions.
- [Building](building.md) — Docker image and binary builds.
