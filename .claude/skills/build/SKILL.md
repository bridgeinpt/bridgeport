---
name: build
description: "Deliver a GitHub issue end-to-end: pick or accept an issue, branch off master, implement with unit tests, run /code-review and /security-review and fix all findings, push, and wait for green CI — ending with a PR ready for the user to merge. Use when the user asks to work on an issue, ship a fix, or pick the next thing to build."
argument-hint: "[issue-number-or-url]"
allowed-tools: Bash, Read, Write, Edit, Skill, AskUserQuestion, Agent
---

# Build

Drive a single BRIDGEPORT GitHub issue to a green-CI, review-clean PR. **Stop at "ready to merge" — the user merges manually** (branch protection enforces this anyway).

This skill orchestrates: it picks the issue, delegates implementation/tests/fixes to subagents, and invokes the built-in `/code-review` and `/security-review` skills. It never edits source files directly.

---

## Step 1: Resolve the issue

Parse `$ARGUMENTS` for a number (`119`) or GitHub URL (`https://github.com/bridgeinpt/bridgeport/issues/119`). Extract `ISSUE_NUMBER` if present.

### If no argument — auto-pick

Fetch open, unassigned issues (limit 50, JSON):

```bash
gh issue list --state open --assignee "" --limit 50 \
  --json number,title,labels,createdAt,body,milestone
```

Score each issue by milestone version, priority labels, and recency.

**Milestone version** — parse `milestone.title` as a dotted numeric version (e.g., `"2.0"` → `[2, 0]`, `"2.1.3"` → `[2, 1, 3]`). Lower versions sort first so we close out older milestones before opening new ones. Non-numeric milestone titles (e.g., `"Backlog"`) and issues without a milestone sort to the end, as if they had version `[Infinity]`.

**Priority tier** — first label match wins, case-insensitive:

| Label match | Tier |
|---|---|
| `P0`, `priority:critical`, `critical` | 0 |
| `P1`, `priority:high`, `bug` | 1 |
| `improvement`, `priority:medium` | 2 |
| `feature`, `enhancement`, `task` | 3 |
| anything else | 4 |

**Sort key**: `(milestone_version asc with nulls last, tier asc, createdAt asc)`. Pick the first. If zero open unassigned issues exist, tell the user and stop.

Example: between an open #500 `bug` (no milestone) and #112 `enhancement` (milestone `2.0`), pick #112 — closing the in-flight milestone is higher leverage than starting on an unscoped bug.

Print: `Picked #<N> [<milestone>]: <title>` and continue.

### If argument provided

Use the number directly. Verify it exists and is open:

```bash
gh issue view <N> --json number,title,body,labels,state,assignees
```

If closed, ask the user via `AskUserQuestion` whether to proceed anyway (default: stop).

Store `ISSUE_NUMBER`, `ISSUE_TITLE`, `ISSUE_BODY`, `ISSUE_LABELS`.

---

## Step 2: Classify and prepare

Derive `BRANCH_PREFIX` and `PR_PREFIX` from labels (first match wins, case-insensitive):

| Label | BRANCH_PREFIX | PR_PREFIX |
|---|---|---|
| `bug` | `fix/` | `fix` |
| `improvement` | `improve/` | `improve` |
| `refactor`, `task`, `chore` | `refactor/` | `refactor` |
| (default — feature/enhancement/anything) | `feat/` | `feat` |

Build `ISSUE_NAME` = kebab-case of the title, capped at ~40 chars (drop trailing words to fit).

Score complexity by summing signals from the issue body:

- Multiple bullet points in scope (3+): +1
- Mentions migration/schema/Prisma: +2
- Mentions multiple subsystems (backend + UI + agent + CLI): +1 each pair
- Body > 800 chars: +1
- Mentions security/auth/RBAC/encryption: +1

| Score | COMPLEXITY |
|---|---|
| 0–1 | easy |
| 2–4 | medium |
| 5+ | complex |

Tell the user: `ISSUE_TYPE=<prefix> COMPLEXITY=<level> BRANCH=<branch> — proceeding.`

Assign the issue to the current user:

```bash
gh issue edit <N> --add-assignee "@me"
```

---

## Step 3: Branch off latest master

```bash
git fetch origin master
git checkout -b <BRANCH_PREFIX><ISSUE_NAME> origin/master
```

If the branch already exists locally, append `-2`, `-3`, etc. until unique.

---

## Step 4: Plan (medium/complex only — skip for easy)

Delegate to a `Plan` subagent. Give it the full issue body and ask for a step-by-step plan that names specific files to change. Keep the agent's returned plan in your working context — pass it inline to Step 5. Do not write it to disk.

```
Agent(subagent_type="Plan", description="Plan implementation for issue #<N>", prompt="""
Plan how to implement BRIDGEPORT issue #<N>.

Issue title: <title>
Issue body:
<body>

Project notes:
- Backend in src/ (Node.js/Fastify/TypeScript)
- Frontend in ui/ (React/Vite/Tailwind)
- Go agent in bridgeport-agent/, Go CLI in cli/
- Prisma schema at prisma/schema.prisma — any schema change REQUIRES a migration in prisma/migrations/ created via `npx prisma migrate dev --name <descriptive>`. See CLAUDE.md for the full rules.
- Use shellEscape() from src/lib/ssh.ts for any value interpolated into shell commands.
- Tests use vitest with two configs: integration (config/vitest.config.ts) and unit (config/vitest.unit.config.ts).

Return:
1. Files to change (with one-line "what" per file)
2. Order of changes
3. Migration plan if Prisma schema is touched
4. Test coverage strategy (which behaviors need unit tests)
5. Any open questions or risks

Keep it under 400 words.
""")
```

---

## Step 5: Implement

Delegate to a `general-purpose` subagent.

```
Agent(subagent_type="general-purpose", description="Implement #<N>", prompt="""
Implement BRIDGEPORT issue #<N> on the current branch.

Issue title: <title>
Issue body:
<body>

<if plan exists:>
Plan to follow (you can deviate with reason):
<plan contents>
</if>

REQUIREMENTS — read these carefully:

1. **Minimal scope**: change only what the issue needs. Do not refactor adjacent code or add unrequested features. Every changed line must be traceable to the issue.

2. **Migrations**: if you edit prisma/schema.prisma, you MUST also create a migration via:
     npx prisma migrate dev --name <short_descriptive_name>
   The skill verifies a new directory under prisma/migrations/ exists before letting the run continue. Do not commit a schema change without its migration.

3. **Shell escaping**: any string interpolated into a command passed to client.exec(), client.execStream(), or execAsync() in src/ MUST be wrapped in shellEscape() from src/lib/ssh.ts. Double-quoting is insufficient.

4. **Helpers**: prefer existing helpers — safeJsonParse, getErrorMessage, parsePaginationQuery from src/lib/helpers.ts; tag-filter utilities from src/lib/image-utils.ts.

5. **Docs**: if you change src/routes/, src/services/, prisma/schema.prisma, ui/src/pages/, or settings code, update the matching file under docs/guides/ or docs/reference/. A hook will warn if you skip this.

6. **No tests yet** — the next step is a dedicated test-writing pass. Do NOT add tests in this pass.

7. **No commits yet** — leave changes staged or unstaged. The skill commits.

8. **Quality**: run `npm run build` (typecheck) and report whether it passes. Do not run the test suite.

Write a brief summary of what you changed (files + one-line per change) to your output. Do not edit anything outside the scopes implied by the issue.
""")
```

After it finishes:

1. Verify Prisma migration consistency:
   ```bash
   git diff --name-only origin/master...HEAD
   ```
   If `prisma/schema.prisma` is in the list, ensure at least one new directory under `prisma/migrations/` is also in the list. If not, re-prompt the agent: "You modified prisma/schema.prisma but did not create a migration. Run `npx prisma migrate dev --name <name>` and stage the new migration files." Loop until the migration exists or the agent reports a blocker.

2. Run typecheck:
   ```bash
   npm run build
   ```
   On failure, send the error output back to the implementation agent and ask it to fix. Loop max 2 times.

3. Stage everything:
   ```bash
   git add -A
   ```

---

## Step 6: Unit tests

Delegate to a `general-purpose` subagent.

```
Agent(subagent_type="general-purpose", description="Add unit tests for #<N>", prompt="""
Write unit tests for the changes on the current branch of BRIDGEPORT.

Diff to cover (use this exact command to see it):
  git diff origin/master...HEAD

Issue context: #<N> — <title>

Requirements:
1. Use vitest. Backend unit tests follow the unit config (config/vitest.unit.config.ts) which mocks Prisma. Place them next to the file under test (e.g., src/lib/foo.ts → src/lib/foo.test.ts).
2. Frontend tests live in ui/ — only add if ui/ files changed.
3. Focus on real behavior — branching logic, edge cases, error paths. Do NOT test framework defaults or pure prop forwarding.
4. After writing tests, run them:
   - Backend unit: `npx vitest run --config config/vitest.unit.config.ts <new test paths>`
   - Backend integration (only if you wrote integration tests): `npx vitest run --config config/vitest.config.ts <paths>`
   - UI: `cd ui && npx vitest run <paths>`
5. Fix any failures from your own new tests.
6. If existing tests in modified modules now fail because they asserted the old behavior, UPDATE THEM to reflect the correct new behavior — search for assertions tied to the changes you're testing.

Do not commit. Report which tests you added and the final pass/fail status.
""")
```

After it finishes, run the full relevant suite to confirm nothing broke:

```bash
npm test
```

And if `ui/` was modified:

```bash
cd ui && npx vitest run
```

If anything fails that wasn't already failing on master, send the failure output back to a fix subagent. Loop max 2 times.

Stage and proceed:

```bash
git add -A
```

---

## Step 7: Commit and open the PR

Compose a commit message following the repo's conventional style (look at `git log --oneline -10` for examples — most commits use `verb description (#N)` form).

```bash
git commit -m "$(cat <<'EOF'
<PR_PREFIX>: <short imperative description> (#<N>)

<one-paragraph body from the issue / what changed>

Closes #<N>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push -u origin HEAD
```

Open the PR (draft initially so we have time for review fixes before CI starts judging):

```bash
gh pr create --draft --base master \
  --title "<PR_PREFIX>: <short description> (#<N>)" \
  --body "$(cat <<'EOF'
## Summary
<1-3 bullets describing the change>

## Implementation notes
<key decisions or call-outs — keep brief>

Closes #<N>

## Test plan
- [x] Unit tests added and passing
- [ ] /code-review run, findings resolved
- [ ] /security-review run, findings resolved
- [ ] CI green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Capture the PR number from `gh pr view --json number --jq .number` and store as `PR_NUMBER`.

Mark ready for review now so CI starts running while we do local reviews:

```bash
gh pr ready <PR_NUMBER>
```

---

## Step 8: /code-review and fix

Invoke the built-in code review skill:

```
Skill(skill="code-review", args="medium")
```

Effort `medium` is the default sweet spot for an issue-scoped change. Use `high` if `COMPLEXITY=complex`.

The skill returns findings inline in this conversation. For each actionable finding (ignore "observation only" / "no change required" notes):

1. Group findings by file/area.
2. Delegate fixes to a `general-purpose` subagent with the full findings text and the same scope/migration/shellEscape rules from Step 5.
3. Re-run typecheck (`npm run build`) and any test files in the modified scope.
4. Stage, commit, push:
   ```bash
   git commit -m "fix code review findings (#<N>)"
   git push
   ```

If the review finds nothing actionable, log "no code-review findings to fix" and continue.

---

## Step 9: /security-review and fix

Invoke the built-in security review skill:

```
Skill(skill="security-review")
```

Apply the same fix pattern as Step 8. Security findings have priority — never skip a Critical or High finding. For Low/Info findings, document why if you choose not to fix.

Commit and push fixes:

```bash
git commit -m "fix security review findings (#<N>)"
git push
```

---

## Step 10: Wait for green CI

Watch CI to completion:

```bash
gh pr checks <PR_NUMBER> --watch
```

This blocks until all required checks finish. Outcomes:

- **All green** → continue to Step 11.
- **One or more failed** → fetch the failing logs:
  ```bash
  gh run list --branch "$(git rev-parse --abbrev-ref HEAD)" --limit 5 --json databaseId,conclusion,name
  gh run view <FAILING_RUN_ID> --log-failed
  ```
  Delegate to a `general-purpose` subagent with the failure log and the diff. Apply fix, commit, push, re-run `gh pr checks --watch`. Maximum 2 fix attempts. After 2 failed attempts, stop and surface the failures to the user.

If checks are skipped or there are 0 runs after 60s, push an empty commit to force a trigger:

```bash
git commit --allow-empty -m "ci: re-trigger checks"
git push
```

---

## Step 11: Done — hand off to the user

Output a concise summary:

```
✓ Issue #<N>: <title>
  Branch: <branch>
  PR: <PR URL>
  Complexity: <level>
  Commits: <count>
  CI: green
  Code review: <findings count> resolved
  Security review: <findings count> resolved

Ready to merge. Squash-merge when you're happy with the PR.
```

Do NOT call `gh pr merge`. The user merges manually.

---

## Notes on behavior

- **Never commit on master.** If `git rev-parse --abbrev-ref HEAD` returns `master` at any commit step, stop and tell the user.
- **Never use `git push --force` or `--no-verify`** unless a hook failure is itself the bug being fixed and the user has authorized it.
- **Branch protection** prevents direct pushes to master, so all work goes through the PR. This is by design.
- **Subagent isolation**: every implementation and fix runs in an `Agent` call so the orchestrator's context stays small. The orchestrator only reads agent summaries and exit status, not full diffs.
- **Hook reminders**: the docs-drift hook (`scripts/check-docs-drift.sh`) will warn at end-of-turn if `src/routes/`, `src/services/`, `prisma/schema.prisma`, `ui/src/pages/`, or settings files changed without a corresponding `docs/` update. The implementation prompt includes a reminder; if the hook still fires, address it before Step 7's commit.

## Variables

| Variable | Source |
|---|---|
| `ISSUE_NUMBER` | argument or auto-pick |
| `ISSUE_TITLE`, `ISSUE_BODY`, `ISSUE_LABELS` | `gh issue view` |
| `BRANCH_PREFIX`, `PR_PREFIX` | label → table in Step 2 |
| `ISSUE_NAME` | kebab-case of title |
| `COMPLEXITY` | scoring heuristic in Step 2 |
| `BRANCH` | `<BRANCH_PREFIX><ISSUE_NAME>` |
| `PR_NUMBER` | output of `gh pr create` |
