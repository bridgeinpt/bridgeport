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

Group changes by category. Omit empty sections. Order them like this:

```markdown
### Breaking changes
- ...

### Migrations
- Describe each new `prisma/migrations/*` directory and what it changes for operators

### Features
- New capability — what it enables (#PR)

### Improvements
- Behavioral change worth knowing about (#PR)

### Fixes
- Bug fixed and the user-visible symptom (#PR)

### Security
- CVE patched / hardening applied (#PR)

### Docs
- Notable doc additions (#PR)

### Internal
- Refactors, dependency bumps, CI-only changes (#PR)
```

Guidelines for entries:
- One line each. Lead with the user-visible effect, not the implementation detail.
- Always link the PR as `(#N)` — GitHub renders these as links in the release page.
- Skip pure noise (formatting-only commits, dependabot bumps with no functional change) from the top-level list. Group dependabot under "Internal" as a single line.
- Migrations get their own section because BridgePort's upgrade story (CLAUDE.md golden rule) makes them user-visible.

## Step 5 — Iterate with the user

Show the draft. Ask if they want changes. Apply edits. Re-show. Stop when they say ship.

## Step 6 — Pick the version

Compute `LAST_VERSION=${LAST_TAG#v}` and propose a default bump:

- **major** — anything in `### Breaking changes`
- **minor** — anything in `### Features` or `### Migrations`
- **patch** — only `### Fixes`, `### Security`, `### Docs`, `### Internal`

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

Write the final notes to a temp file and use it with `-F` so the message is preserved exactly:

```bash
cat > /tmp/bridgeport-release-notes.md <<'EOF'
<final notes>
EOF

git tag -a "v${VERSION}" -F /tmp/bridgeport-release-notes.md
git push origin "v${VERSION}"
```

## Step 9 — Report

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
