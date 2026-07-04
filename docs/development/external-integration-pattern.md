# External Integration Config Pattern

> **Status: convention — adopt in new code.** Five planned features each add an
> admin-configured external endpoint with a stored credential:
> [#323](https://github.com/bridgeinpt/bridgeport/issues/323) (OIDC provider),
> [#109](https://github.com/bridgeinpt/bridgeport/issues/109) (secret providers),
> [#326](https://github.com/bridgeinpt/bridgeport/issues/326)/[#364](https://github.com/bridgeinpt/bridgeport/issues/364) (notification channels),
> [#330](https://github.com/bridgeinpt/bridgeport/issues/330) (audit drain),
> [#348](https://github.com/bridgeinpt/bridgeport/issues/348) (webhook receivers).
> They share no schema, but they MUST share these conventions so admins get one
> consistent experience and reviewers get one checklist. `RegistryConnection`
> and `SlackChannel` are the shipped precedents.

## Schema conventions

- Credential columns come in pairs: `<name>Encrypted` + `<name>Nonce`,
  AES-256-GCM via the existing `src/lib/encryption.ts` helpers. Never store a
  provider credential in plaintext or in a JSON blob.
- Every config row carries `enabled Boolean @default(true)` — disabling must be
  possible without deleting (and losing) the configuration.
- Scope explicitly: env-scoped configs relate to `Environment` with
  `onDelete: Cascade`; system-wide configs live in system settings or a
  singleton table. Don't default to global out of convenience.

## API conventions

- **Credentials are write-only.** Read/list responses never include the
  decrypted value — return a boolean `hasCredential` (or masked hint) instead.
  On update, an absent/empty credential field means "keep the existing value";
  rotating requires sending a new one.
- **Every integration exposes a test action** (`POST .../test`) that exercises
  the real path — OIDC discovery + JWKS fetch, a test notification, a drain
  test batch, a signature self-check — and returns a structured
  success/failure with the upstream error message. The UI renders this as a
  Test button next to the form.
- Config mutations are **admin-only** (`requireAdmin`) and **audit-logged**
  (create/update/delete/test — never logging the credential itself).
- Outbound calls set explicit timeouts and never follow redirects to
  non-HTTPS. If the endpoint URL is user-supplied, treat it as untrusted:
  the SSRF guards in `src/lib/` apply (no internal-network targets unless the
  feature explicitly requires it and says so).

## UI conventions

- shadcn `Form` + zod; credential inputs use `type="password"` with a
  "leave blank to keep current" hint on edit.
- Test button with inline success/error feedback (Sonner toast + last-test
  status persisted where useful, e.g. drains).
- Enabled toggle separate from delete; deletes confirm via `useConfirm()`.

## Checklist for PRs adding an integration

- [ ] Credential stored as `*Encrypted` + `*Nonce` (AES-256-GCM), write-only in API
- [ ] `enabled` flag; explicit env vs system scoping with correct cascade
- [ ] Test-connection endpoint + UI button exercising the real path
- [ ] Admin-only routes; config changes audit-logged without credential values
- [ ] Outbound timeout + SSRF posture stated
- [ ] SDK methods + OpenAPI snapshot + docs in the same PR (repo policy)
