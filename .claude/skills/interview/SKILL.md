---
argument-hint: [instructions]
description: Interview user in-depth, then file the resulting spec as a GitHub issue
allowed-tools: AskUserQuestion, mcp__github__issue_write, mcp__github__sub_issue_write, mcp__github__issue_read, mcp__github__search_issues, mcp__github__list_issues, mcp__github__get_label
---

Follow the user instructions and interview me in detail using the AskUserQuestion tool about literally anything: technical implementation, UI & UX, concerns, tradeoffs, etc. but make sure the questions are not obvious. be very in-depth and continue interviewing me continually until it's complete.

<instructions>$ARGUMENTS</instructions>

## Final output: a GitHub issue (not a local file)

When the interview is complete, deliver the spec as a GitHub issue in this repository. Do NOT write the spec to a local file — `specs/` is gitignored here for a reason.

1. **Draft the issue** in the repo's house style (look at recent issues for the pattern): `## Summary`, background/context, the settled decisions from the interview (a decisions table works well), proposed scope, out-of-scope list, and `## Acceptance criteria` checkboxes.

2. **Gather repo metadata before filing:**
   - **Labels:** check which labels actually exist (`get_label` / recent issues) and pick the applicable ones (e.g. `enhancement`, `backend`, `frontend`, `security`). Never invent new labels.
   - **Milestone:** find open milestones by inspecting recent issues (`search_issues` with `milestone:"<title>"` returns the milestone number in the payload). Pick the one that fits the feature's size and the milestone's stated scope.
   - **Epics/structure:** search for an existing epic or related issues the spec could attach to.

3. **Confirm with the user before creating anything.** Ask one final AskUserQuestion round covering:
   - the **suggested milestone** (your pick, plus the plausible alternatives) — the user confirms;
   - the **structure**: file it as a single issue, attach it as a sub-issue of an existing epic, or split it into an epic with sub-issues (propose the breakdown — e.g. backend/data-model, alerting, UI, API/SDK — and let the user choose);
   - the proposed **labels**.

4. **Create the issue(s)** with `issue_write` (title, body, confirmed labels, confirmed milestone number). If the user chose a breakdown, create the parent epic first, then the sub-issues, and link them with `sub_issue_write`.

5. **Report back** with the issue URL(s) and a one-paragraph recap of the key decisions captured.
