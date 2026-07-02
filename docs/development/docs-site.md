# Docs Site Deployment

How the public documentation site is built and deployed.

## Stack

The site is built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build), living in [`website/`](../../website). Page content is authored in [`docs/`](../) (this directory) plus the checked-in [`openapi.json`](../../openapi.json) spec — `website/astro.config.mjs` points Starlight at both and defines the sidebar. The site is a standalone pnpm workspace with its own lockfile (`website/pnpm-lock.yaml`), separate from the root workspace.

Hosting is Cloudflare Pages, with the Pages project connected directly to this GitHub repository.

## CI vs. deploy

Two separate things happen when `docs/**`, `openapi.json`, or `website/**` change:

1. **CI check** — [`.github/workflows/docs-site.yml`](../../.github/workflows/docs-site.yml) runs `astro build` on every push/PR to those paths. The build runs `starlight-links-validator` and parses `openapi.json`, so a broken internal link or a malformed spec fails the check. It does **not** deploy anything.
2. **Deploy** — handled entirely by Cloudflare Pages' own git integration: on every push to `master`, Cloudflare pulls the repo, builds `website/`, and publishes the result. This is configured in the Cloudflare Pages dashboard (build command, output directory, root directory), not in this repo.

So a normal merge to `master` that touches the docs deploys automatically — no GitHub Actions step triggers it.

## The `CLOUDFLARE_DEPLOY_HOOK` secret

The site's changelog page is generated from GitHub Releases at *build* time. Cloudflare only rebuilds on a `master` push, so a new GitHub Release wouldn't show up on the changelog until the next docs-related commit. The `CLOUDFLARE_DEPLOY_HOOK` repo secret (a Cloudflare Pages deploy hook URL) exists to force a rebuild in that case:

- [`.github/workflows/docs-deploy-on-release.yml`](../../.github/workflows/docs-deploy-on-release.yml) POSTs the hook when a Release is published/edited via the GitHub UI, or via manual `workflow_dispatch`.
- [`.github/workflows/release.yml`](../../.github/workflows/release.yml)'s "Refresh docs changelog" step POSTs the hook after the `/release` flow cuts a Release — that flow authenticates as `GITHUB_TOKEN`, and GitHub does not fire `release: published` events for `GITHUB_TOKEN`-created releases, so the dedicated workflow above can't catch it.

Both call sites are non-fatal no-ops if the secret is unset — they log a message and exit `0` rather than fail the workflow.

**One-time setup** (already done for this repo; documented here for reference): in the Cloudflare Pages project, go to Settings → Builds & deployments → Deploy hooks, create a hook for the production/`master` branch, then store its URL as the `CLOUDFLARE_DEPLOY_HOOK` repo secret (repo Settings → Secrets and variables → Actions). Never commit the hook URL itself — treat it as a bearer-style trigger.

> [!NOTE]
> General guidance, not specific to this repo's history: Cloudflare's fine-grained API tokens can be fiddly to scope correctly when (re-)connecting a Pages project to a repo — it's easy to over-grant Account/Zone permissions. If you're setting this up, scope the token to **Pages** only.

## Custom domain

Custom-domain mapping for the Pages project is configured entirely in the **Cloudflare Pages dashboard** (Custom domains tab) — there's no repo-side config for it. The canonical site URL is set separately in code via the `site` value in [`website/astro.config.mjs`](../../website/astro.config.mjs) (used for sitemap/OG tag generation, not for routing).

## When a docs deploy doesn't happen

1. Check the **Cloudflare Pages dashboard → Deployments** tab for the project and read the build log for the missing deploy. Most failures are a build-time error (bad Astro/Starlight config, a broken link caught differently than CI, etc.) rather than a trigger problem, since Cloudflare's git integration doesn't depend on any GitHub Actions state.
2. If the missing content is specifically the **changelog** (a new Release not appearing), check whether `CLOUDFLARE_DEPLOY_HOOK` is set (repo Settings → Secrets and variables → Actions) and look at the run logs for `docs-deploy-on-release.yml` or the "Refresh docs changelog" step in `release.yml` — both log clearly when the secret is missing or the POST fails.
3. Confirm [`docs-site.yml`](../../.github/workflows/docs-site.yml) (the CI check) is green on the merged commit. A red CI check doesn't block Cloudflare's deploy, but it's a strong signal something in the same change would also break the live build.

## Related

- [Building](building.md) — how the main BridgePort image and binaries are built (a separate pipeline from the docs site).
- [`docs/README.md`](../README.md) — index of all docs, mirrored in the site's sidebar (`website/astro.config.mjs`).
