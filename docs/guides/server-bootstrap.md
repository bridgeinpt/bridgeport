# Server Bootstrap

One-click setup that prepares a fresh Ubuntu or Debian server to run BridgePort-managed workloads: installs Docker Engine + the Compose plugin, deploys the monitoring agent, applies BridgePort's sysctl defaults, and (optionally) configures a swap file.

## Table of Contents

1. [Quick Start](#quick-start)
2. [What gets installed](#what-gets-installed)
3. [Requirements](#requirements)
4. [Running a Bootstrap](#running-a-bootstrap)
5. [Adding swap later](#adding-swap-later)
6. [API Reference](#api-reference)
7. [Troubleshooting](#troubleshooting)

---

## Quick Start

1. Register a server (see [Servers](servers.md)) and confirm SSH connectivity.
2. Open the server detail page and locate the **Bootstrap** card.
3. Click **Bootstrap server**, pick the components you want (defaults: Docker, sysctl, agent), and click **Start Bootstrap**.
4. Watch the live log pane until completion. Each step's status persists on the card after the modal closes.

Bootstrap is idempotent — re-running it on an already-bootstrapped server is safe; each step skips work it has already done.

---

## What gets installed

| Component | What it does |
| --- | --- |
| **Docker** | Runs `get.docker.com` (official Docker convenience script). Installs `docker-ce`, `containerd`, and the **`docker-compose-plugin`** so `docker compose ...` works out of the box. Enables + starts the daemon and adds the SSH user to the `docker` group. |
| **sysctl** | Drops `/etc/sysctl.d/99-bridgeport.conf` with `vm.swappiness=10` and `fs.file-max=2097152`, then runs `sysctl --system`. The file is rewritten every run so changes here propagate via bootstrap. |
| **Agent** | Reuses the existing agent deploy flow (same SSH key, same systemd unit at `/etc/systemd/system/bridgeport-agent.service`). Sets the server to `agent` metrics mode. |
| **Swap** | Creates `/swapfile` of the chosen size (128–65536 MB), formats it with `mkswap`, activates it with `swapon`, and persists it via `/etc/fstab`. `/etc/fstab` is backed up to `/etc/fstab.bridgeport.bak` the first time bootstrap touches it. |

The Docker install path uses Docker's convenience script — it pulls the Compose **plugin**, not the legacy standalone `docker-compose` binary. Existing servers running the standalone binary keep working; bootstrap won't downgrade them.

---

## Requirements

- **Distro**: Ubuntu or Debian. Other distros are rejected up-front with a clear error.
- **Privilege**: Passwordless sudo (`NOPASSWD` in `/etc/sudoers`) for the SSH user, or root SSH. The Bootstrap card surfaces a yellow banner when sudo would prompt for a password.
- **Network**: outbound HTTPS to `get.docker.com` for the Docker step.

The card runs a live probe each time it loads: it shows the detected distro, whether passwordless sudo works, and a `free -m` snapshot for swap sizing.

---

## Running a Bootstrap

1. **UI** — Server detail page > **Bootstrap** card > **Bootstrap server**. Pick components, set a swap size if you want swap, click **Start Bootstrap**. The modal streams progress via SSE; closing it does not cancel the run (the bootstrap continues in the background).
2. **API** — see [API Reference](#api-reference) below.

Component order is fixed: `distro check → sudo preflight → docker → sysctl → swap → agent`. A failure in one component does not skip the rest; each gets its own success/error entry in the final audit log.

After bootstrap finishes:
- `Server.bootstrapState` is set to `bootstrapped` (all selected components succeeded) or `error` (one or more failed).
- Per-component timestamps (`dockerInstalledAt`, `sysctlAppliedAt`, etc.) are set on each successful step.
- An `audit_log` entry of action `bootstrap` records the full result.

---

## Adding swap later

If you skipped swap during bootstrap, the dedicated swap endpoint can add one later without re-running anything else. It captures `free -m` before and after into the audit log so you can verify the change took effect.

If swap is already present, the call fails with a clear error unless you pass `force: true` (which appends another fstab entry — usually not what you want; consider resizing the existing file instead).

---

## API Reference

### `GET /api/servers/:id/bootstrap`

Returns the cached per-component status plus a best-effort live probe (distro, sudo, current memory).

```jsonc
{
  "bootstrapState": "not_bootstrapped",
  "bootstrapDistro": "ubuntu:22.04",
  "dockerInstalled": true,
  "dockerInstalledAt": "2026-05-27T10:00:00Z",
  "agentInstalled": false,
  "agentInstalledAt": null,
  "sysctlApplied": true,
  "sysctlAppliedAt": "2026-05-27T10:00:30Z",
  "swapConfigured": false,
  "swapConfiguredAt": null,
  "swapSizeMb": null,
  "distro": { "distro": "ubuntu", "supported": true, "raw": "ubuntu:22.04" },
  "sudo": { "ok": true },
  "memory": "              total        used        free ..."
}
```

### `POST /api/servers/:id/bootstrap`

Kicks off a bootstrap run in the background. Returns `202 { "started": true }` immediately. Watch the SSE event stream for `bootstrap_progress` events scoped to this server.

```http
POST /api/servers/:id/bootstrap
Content-Type: application/json

{
  "components": { "docker": true, "sysctl": true, "agent": true, "swap": false },
  "swapSizeMb": 2048
}
```

`swapSizeMb` is required when `components.swap` is `true` and must fall in `[128, 65536]`.

Requires the **operator** or **admin** role.

### `POST /api/servers/:id/bootstrap/swap`

Live-add a swap file outside of the full bootstrap flow.

```http
POST /api/servers/:id/bootstrap/swap
Content-Type: application/json

{ "sizeMb": 2048, "confirm": true, "force": false }
```

`confirm: true` is required (defensive — guards against accidental requests).
Returns `before` and `after` snapshots of `free -m`. Requires the **operator** or **admin** role.

### SSE events

The existing `/api/events` stream emits `bootstrap_progress` events while a run is in flight:

```jsonc
{
  "serverId": "clxyz...",
  "environmentId": "clenv...",
  "component": "docker",  // optional: docker | sysctl | agent | swap | distro | preflight
  "phase": "step",        // start | step | done | error
  "level": "info",        // info | error
  "line": "[docker] downloading get.docker.com installer"
}
```

---

## Troubleshooting

**"Passwordless sudo is required"** — Either log in as root, or add a sudoers drop-in such as:

```
echo 'deploy ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/bridgeport
sudo chmod 440 /etc/sudoers.d/bridgeport
```

**"Unsupported distro"** — Bootstrap supports Ubuntu and Debian only. For other distros (RHEL, Alpine, etc.) install Docker manually and deploy only the agent via [Monitoring agent](../reference/agent.md).

**Bootstrap finished with errors** — Each step's stdout/stderr is captured in the audit log under action `bootstrap` (and individual `configure_swap` actions). Re-running bootstrap is safe — the idempotent probes skip work that has already succeeded.

**Swap not active after reboot** — Check `/etc/fstab` for the `/swapfile none swap sw 0 0` line. If absent, re-run bootstrap with swap selected; if present, run `sudo swapon -a` to load it without rebooting.

---

## Related

- [Servers](servers.md) — register, SSH key, health checks
- [Monitoring agent](../reference/agent.md) — what the agent collects, manual install
