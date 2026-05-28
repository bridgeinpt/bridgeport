# Supply Chain Hardening

BRIDGEPORT applies a few defensive defaults to reduce the blast radius of compromised npm packages (typosquats, malicious post-install scripts, and freshly-published-then-yanked versions). This page explains the defaults, the trade-offs, and the escape hatches.

## Requirements

You need **npm 11.10 or newer**. The `min-release-age` setting we use (see [Defaults](#defaults)) was added in npm 11.10.0; older npm versions silently ignore the key and the cooldown is **not enforced**.

Check your version with `npm --version`. If it is below 11.10:

```bash
npm install -g npm@latest
```

Node.js 20.x ships with npm 10. CI installs `npm@latest` after `actions/setup-node` for the same reason — see [`.github/workflows/test.yml`](../../.github/workflows/test.yml).

## Defaults

Both `/.npmrc` and `/ui/.npmrc` set:

```ini
min-release-age=1
ignore-scripts=true
```

### `ignore-scripts=true`

npm runs `preinstall`, `install`, and `postinstall` lifecycle scripts from every package in the dependency tree by default. A single compromised transitive dependency can therefore execute arbitrary code on a developer machine or in CI the moment `npm install` runs.

Setting `ignore-scripts=true` blocks all of those hooks. Packages that genuinely need a native compile step must be rebuilt explicitly with `npm rebuild <pkg>` after install.

### `min-release-age=1`

A version published in the last 24 hours is statistically the most likely to be a malicious release (compromised maintainer account, supply chain attack, accidental publish). `min-release-age=1` tells npm to skip versions younger than one day when resolving ranges, giving the wider community time to spot and yank a bad release.

This does not lock the lockfile — once a version is older than the cooldown it will be picked up normally on the next install.

## Allowed native modules

These dependencies ship native bindings and need post-install scripts (or an explicit rebuild) to be usable:

- `better-sqlite3` — primary SQLite driver. The production [`docker/Dockerfile`](../../docker/Dockerfile) explicitly runs `npm rebuild better-sqlite3` after `npm ci --ignore-scripts` so the prebuilt binary is downloaded (or compiled from source as a fallback).
- `prisma` / `@prisma/client` — Prisma's CLI fetches query-engine binaries during `prisma generate`. We invoke `prisma generate` explicitly in the Dockerfile and CI, so the install-time scripts being disabled is fine.
- `ssh2` — uses an optional native crypto accelerator (`cpu-features`). The pure-JS fallback works everywhere; the native acceleration is only used when present.
- `esbuild` — Vite uses esbuild's prebuilt binary. Vite invokes esbuild lazily on first use, which works without install scripts.

CI workflows that run `npm ci` for the backend mirror the Dockerfile by running `npm rebuild better-sqlite3` immediately after install (see [`.github/workflows/test.yml`](../../.github/workflows/test.yml) and [`stress.yml`](../../.github/workflows/stress.yml)).

## Developer workflow

### A package needs install scripts

If you're adding a new dependency that has a legitimate post-install step, install it once with scripts enabled:

```bash
npm install --foreground-scripts <pkg>
```

Or run `npm rebuild <pkg>` after a normal install. If the package becomes a permanent dependency that always needs rebuilding, add a corresponding `npm rebuild` step to the Dockerfile and the relevant CI workflows.

### Emergency: bypassing the cooldown

If you genuinely need to pull a brand-new version (CVE patch released minutes ago, hotfix you authored yourself, etc.), override the cooldown for a single install:

```bash
npm install --min-release-age=0 <pkg>
```

Do not change the `.npmrc` default. The cooldown exists precisely so that the urgent-feeling case gets a second pair of eyes.

## Dependabot cooldown

[`.github/dependabot.yml`](../../.github/dependabot.yml) applies a matching cooldown to each ecosystem so Dependabot does not open a PR for a version that `npm` would refuse to install locally. npm ecosystems use 3–7 days depending on semver bump; Docker, GitHub Actions, and Go modules use a flat 3-day cooldown.

Security updates bypass Dependabot's cooldown automatically — a CVE patch will still open immediately.

## Related

- [Setup](setup.md) — first-time install instructions.
- [Building](building.md) — Docker image and binary builds.
