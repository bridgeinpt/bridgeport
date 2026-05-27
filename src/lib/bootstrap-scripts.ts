/**
 * Pure shell-script builders for server bootstrap (issue #113).
 *
 * These functions return strings — they perform no I/O — so they can be
 * unit-tested without an SSH connection. The scripts themselves are idempotent
 * (re-running them on an already-bootstrapped server should be a no-op).
 *
 * SECURITY: any caller-provided value interpolated into a script (e.g. swap
 * size) MUST be wrapped in `shellEscape()` from `src/lib/ssh.ts`. Double-
 * quoting is insufficient because `$`, backticks, and `$()` are still
 * interpreted by the shell.
 */

import { shellEscape } from './ssh.js';

/**
 * Detect the host's distro+version. Outputs `id:version_id` on stdout (e.g.
 * `ubuntu:22.04`, `debian:12`). Returns an empty string if /etc/os-release
 * isn't present.
 */
export function distroDetectScript(): string {
  return '. /etc/os-release 2>/dev/null && echo "$ID:$VERSION_ID" || echo ""';
}

/**
 * Probe for passwordless sudo. Exits non-zero if sudo would prompt for a
 * password. Captures stderr so callers can surface "a password is required"
 * style messages.
 */
export function sudoPreflightScript(): string {
  return 'sudo -n true 2>&1';
}

/**
 * Install Docker Engine + Compose plugin via Docker's official `get.docker.com`
 * convenience script. Idempotent: if `docker` and `docker compose` are already
 * present, the script reports success without touching the system. Targets
 * Ubuntu and Debian — caller is responsible for detecting the distro first.
 *
 * Adds the SSH user to the `docker` group so subsequent `docker` commands
 * don't need sudo. The group change applies on the next SSH session — the
 * bootstrap orchestrator's verification step uses `sudo -n docker ...` so it
 * works immediately.
 */
export function dockerInstallScript(): string {
  return [
    'set -e',
    '# Idempotency probe: if docker + compose plugin already there, nothing to do.',
    'if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then',
    '  echo "[docker] already installed"',
    '  docker --version',
    '  docker compose version',
    '  exit 0',
    'fi',
    'echo "[docker] downloading get.docker.com installer"',
    '# get.docker.com installs docker-ce + containerd + docker-compose-plugin.',
    'curl -fsSL https://get.docker.com -o /tmp/get-docker.sh',
    'echo "[docker] running installer (this may take a few minutes)"',
    'sudo sh /tmp/get-docker.sh',
    'rm -f /tmp/get-docker.sh',
    'echo "[docker] enabling + starting service"',
    'sudo systemctl enable docker',
    'sudo systemctl start docker',
    '# Add invoking user to docker group (only effective on next session, but',
    '# bootstrap uses sudo for verification so this is best-effort).',
    'if [ -n "${SUDO_USER:-}" ]; then',
    '  sudo usermod -aG docker "$SUDO_USER" || true',
    'elif [ "$(id -u)" != "0" ]; then',
    '  sudo usermod -aG docker "$(id -un)" || true',
    'fi',
    'echo "[docker] verifying installation"',
    'sudo docker --version',
    'sudo docker compose version',
  ].join('\n');
}

/**
 * Drop a curated sysctl file at `/etc/sysctl.d/99-bridgeport.conf` and reload.
 * Idempotent: rewrites the file on every run (cheap) but only takes effect on
 * `sysctl --system`. The settings are conservative defaults appropriate for a
 * container host:
 *
 * - `vm.swappiness=10` — prefer RAM over swap, only swap when really needed.
 * - `fs.file-max=2097152` — raise the system-wide file descriptor cap to
 *   accommodate busy containers.
 */
export function sysctlScript(): string {
  // The file content is written with `tee` and a heredoc-style here-string.
  // No caller-controlled values are interpolated — the content is static — so
  // shell-escaping isn't required here.
  return [
    'set -e',
    'echo "[sysctl] writing /etc/sysctl.d/99-bridgeport.conf"',
    "sudo tee /etc/sysctl.d/99-bridgeport.conf > /dev/null <<'BRIDGEPORT_SYSCTL_EOF'",
    '# BRIDGEPORT-managed sysctl defaults. Edit values here and re-run bootstrap',
    '# to apply changes; do not edit the file directly on the host.',
    'vm.swappiness=10',
    'fs.file-max=2097152',
    'BRIDGEPORT_SYSCTL_EOF',
    'echo "[sysctl] reloading"',
    'sudo sysctl --system >/dev/null',
    'echo "[sysctl] verifying"',
    '[ -f /etc/sysctl.d/99-bridgeport.conf ] && echo "[sysctl] OK"',
  ].join('\n');
}

/**
 * Create a `/swapfile` of the requested size in MB, format + activate it, and
 * persist it via `/etc/fstab`. Idempotent in two ways:
 *
 * 1. Skips creation if `/swapfile` is already active (`swapon --show` lists it).
 * 2. Appends the fstab line only if `/swapfile` is not already mounted via
 *    fstab (first-field awk match — tolerates whitespace / option variants).
 *
 * Backs up `/etc/fstab` to `/etc/fstab.bridgeport.bak` the first time it's
 * touched. `sizeMb` is shell-escaped — callers can pass it from untrusted
 * sources.
 *
 * @param sizeMb Swap file size in megabytes. Caller MUST validate range before
 *   calling (this function does not enforce bounds; it only escapes the value).
 */
export function swapScript(sizeMb: number): string {
  // Even though sizeMb is a number, render it through shellEscape after
  // String(...) so any future refactor that accepts a wider type stays safe.
  const escaped = shellEscape(String(sizeMb));
  const fstabLine = '/swapfile none swap sw 0 0';
  return [
    'set -e',
    'if swapon --show 2>/dev/null | grep -q "^/swapfile "; then',
    '  echo "[swap] /swapfile already active"',
    'else',
    `  SIZE_MB=${escaped}`,
    '  echo "[swap] creating /swapfile (${SIZE_MB} MB)"',
    '  # fallocate is fast on modern filesystems; dd is the portable fallback.',
    '  if ! sudo fallocate -l "${SIZE_MB}M" /swapfile 2>/dev/null; then',
    '    sudo dd if=/dev/zero of=/swapfile bs=1M count="${SIZE_MB}" status=progress',
    '  fi',
    '  sudo chmod 600 /swapfile',
    '  sudo mkswap /swapfile',
    '  sudo swapon /swapfile',
    'fi',
    '# Persist via fstab. Back up once, then append the line if absent.',
    'if [ ! -f /etc/fstab.bridgeport.bak ]; then',
    '  sudo cp /etc/fstab /etc/fstab.bridgeport.bak',
    'fi',
    `FSTAB_LINE='${fstabLine}'`,
    // Use awk on the first whitespace-delimited field so a pre-existing
    // `/swapfile swap swap defaults 0 0` (or tab-separated, different opts)
    // is recognised — avoids appending a duplicate fstab entry.
    'if ! awk \'$1=="/swapfile" {found=1} END{exit !found}\' /etc/fstab; then',
    '  echo "[swap] appending /etc/fstab"',
    '  echo "$FSTAB_LINE" | sudo tee -a /etc/fstab >/dev/null',
    'fi',
    'echo "[swap] verifying"',
    'swapon --show | grep -q /swapfile && echo "[swap] OK"',
  ].join('\n');
}
