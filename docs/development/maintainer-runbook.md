# Maintainer Runbook

Operational knowledge for whoever maintains this repo — the process, settings, and judgment calls that aren't visible from the code itself. Complements [CLAUDE.md](../../CLAUDE.md) (day-to-day development pitfalls), [Building](building.md) (how artifacts are built), and [Docs Site Deployment](docs-site.md) (the website). Nothing here is needed to *contribute*; all of it is needed to *run the project*.

## Releases

Versioning is git-derived at build time (`YYYYMMDDHH-{sha}` for the app; agent/CLI versions from the last commit touching their directories) — there are no version files to bump. See [CLAUDE.md → Versioning](../../CLAUDE.md) and [Building](building.md).

Cutting a release:

1. Master is always releasable; the Docker image for every master commit is built and pushed by `build.yml` (which does **not** run on PRs — verify image/Dockerfile changes locally before merging).
2. Create an annotated tag and a GitHub Release from it. **Always tag with `--cleanup=verbatim`** — git's default message cleanup strips `#`-prefixed lines, which silently deletes every Markdown heading in the notes (v2.0.0 shipped with its headers eaten this way).
3. Release-notes house style: rich formatting — `##`/`###` grouped sections (Features / Fixes / Ops), an explicit **action-required** callout when operators must do something, and code snippets for commands. Not a flat bullet list.
4. After publishing, the docs changelog refreshes automatically: `release.yml` POSTs the Cloudflare deploy hook itself (required — GitHub fires no workflow events for `GITHUB_TOKEN`-created releases). Releases published or edited manually in the GitHub UI are covered by the **Docs Site Redeploy** workflow instead.

### Go SDK (`client/`) and the Terraform provider

- Any API change the SDK should expose lands the matching SDK method **in the same PR**, with `client/VERSION` bumped (semver: new method = minor, behavior change/removal = major). CI auto-tags `client/vX.Y.Z` on merge to master from that marker.
- When an SDK change is **breaking**, or resolves a gap the provider repo raised, open/comment an issue on [`terraform-provider-bridgeport`](https://github.com/bridgeinpt/terraform-provider-bridgeport) — the provider pins a `client/vX.Y.Z` and must never silently fall behind. The provider is a separate repo published to the Terraform and OpenTofu registries; the `provider acceptance (TF_ACC)` PR check in this repo runs its acceptance suite against the PR image to catch contract breaks early.

## Dependencies & supply chain

- Dependabot runs with **grouped updates** (see `.github/dependabot.yml`) so routine bumps arrive as a few grouped PRs, not dozens.
- For a CVE in a **transitive** dependency, bump the nearest parent that pulls it in. Never run `npm audit fix --force` — it downgrades/upgrades across majors blindly.
- Install-time script execution is restricted: the `allowBuilds` allowlist in `pnpm-workspace.yaml` is the only place native builds are permitted (see [Supply Chain](supply-chain.md)).
- `@codemirror/state` is pinned to a single copy via a pnpm override — a duplicated copy (typically after an unrelated dev-dep bump shifts the lockfile) crashes the editor; the symptom is ConfigFiles/Fragments frontend tests failing around "Included fragments:".

## CI & repo settings

Things configured in GitHub settings rather than in files, plus non-obvious check behavior:

- **Branch protection on `master`** — no direct pushes; everything lands via PR.
- **Actions allowlist** — only approved actions run. An un-allowlisted third-party action fails the job with `startup_failure` (looks like CI is broken, is actually policy). Extend the allowlist in repo/org Actions settings before introducing a new action.
- **CodeQL false positive** to know about: adding Fastify `{schema}` route options to a handler already covered by the global rate limiter trips `js/missing-rate-limiting`. Dismiss it — the global limiter applies.
- **OpenAPI checks**: route-schema changes need `pnpm run openapi:dump` + the committed snapshot (the "OpenAPI Spec Drift" check), and body-less write routes can drop the WRITE-body coverage ratchet below its 0.62 floor — fix the route, never the floor. Details in [CLAUDE.md](../../CLAUDE.md).
- **Repo secret inventory**: `CLOUDFLARE_DEPLOY_HOOK` (Cloudflare Pages deploy-hook URL; used by `release.yml` and the Docs Site Redeploy workflow). On the Cloudflare side, the Pages project carries a `GH_API_TOKEN` build env var (no-scope PAT) authenticating the changelog/roadmap build-time fetches. Full docs-site operations: [Docs Site Deployment](docs-site.md).

## Issue-tracker conventions

- **Milestones are major waves** (the next one open and scoped; one backlog milestone behind it). Milestones describe intent, not commitments — no due dates.
- **Epics are native GitHub sub-issue hierarchies**: a tracking issue labelled `epic` with the member issues attached as sub-issues. Epic bodies carry the sequencing and the boundary decisions between members. Large issues get split into implementable sub-issues under themselves (pattern: #316 → #338/#339/#340), so the epic tree is epic → issues → sub-issues.
- **Label taxonomy**: type (`bug`, `enhancement`, `epic`, plus GitHub's triage set), component (`backend`, `frontend`, `agent`, `cli`), cross-cutting (`security`, `performance`, `ci`, `documentation`, `dependencies`), contributor-facing (`good first issue`, `help wanted` — these feed the "Want to help?" block on the site's What's Next page).
- **Issue bodies carry a "What exists today (grounding)" section.** Grounding rots: before implementing an issue that has sat for a while, re-verify its claims against the code and correct the body (the 2026-07-03 milestone-tightening pass, visible in the 4.0 issues' edit history, is the reference example — several plans referenced models and primitives that didn't exist or already did).
- The docs site's **What's Next page** (`/roadmap/`) renders open milestones/epics at build time; after tracker-only changes (filing, closing, or moving issues), run the **Docs Site Redeploy** workflow to refresh it — merges to master refresh it automatically.

## Naming & external surfaces

- **BridgePort** is the product; **BridgeIn** is the maintainer company; **bridgeinpt** is the GitHub org. Don't mix them in code, docs, or search-and-replace sweeps. Visual identity (the crane mark is deliberately name-independent) is covered in [BRANDING.md](../BRANDING.md).
- Public surfaces to keep in mind when changing behavior: the docs site ([bridgeport.bridgein.com](https://bridgeport.bridgein.com)), the OpenAPI snapshot + [API stability policy](../api-stability.md), the Go SDK tags, the Terraform/OpenTofu registry provider, and ghcr.io images.
- Error monitoring (Sentry, backend + frontend) is optional and env-var driven — a fresh deployment works without it.
- For debugging against a live instance read-only, use the `BRIDGEPORT_URL`/`BRIDGEPORT_TOKEN` service-account pattern described in [Troubleshooting](../operations/troubleshooting.md#querying-a-live-instance-read-only-api-access).
