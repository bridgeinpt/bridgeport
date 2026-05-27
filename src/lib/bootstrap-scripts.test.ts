import { describe, it, expect } from 'vitest';
import {
  distroDetectScript,
  sudoPreflightScript,
  dockerInstallScript,
  sysctlScript,
  swapScript,
} from './bootstrap-scripts.js';

describe('bootstrap-scripts', () => {
  // ==================== distroDetectScript ====================
  describe('distroDetectScript', () => {
    it('sources /etc/os-release and prints "ID:VERSION_ID"', () => {
      const script = distroDetectScript();
      // Exact-shape assertion: must read /etc/os-release and echo $ID:$VERSION_ID
      expect(script).toContain('/etc/os-release');
      expect(script).toContain('echo "$ID:$VERSION_ID"');
    });

    it('falls back to empty string when /etc/os-release is missing', () => {
      const script = distroDetectScript();
      // The `||` branch should produce the empty-string fallback so callers
      // can detect "unknown distro" without parsing error output.
      expect(script).toMatch(/\|\|\s*echo\s+""/);
    });
  });

  // ==================== sudoPreflightScript ====================
  describe('sudoPreflightScript', () => {
    it('runs `sudo -n true` and merges stderr into stdout', () => {
      const script = sudoPreflightScript();
      expect(script).toBe('sudo -n true 2>&1');
    });
  });

  // ==================== dockerInstallScript ====================
  describe('dockerInstallScript', () => {
    it('includes set -e for fail-fast behaviour', () => {
      expect(dockerInstallScript()).toContain('set -e');
    });

    it('probes for both docker and `docker compose version` before installing', () => {
      const script = dockerInstallScript();
      // Both checks must be in the idempotency probe; otherwise we'd reinstall
      // when only the daemon was present but compose plugin missing.
      expect(script).toContain('command -v docker');
      expect(script).toContain('docker compose version');
    });

    it('exits 0 when docker is already installed (idempotent)', () => {
      const script = dockerInstallScript();
      // The probe block ends with `exit 0` so the script is a no-op on re-run.
      expect(script).toMatch(/already installed[\s\S]*exit 0/);
    });

    it('uses get.docker.com convenience installer', () => {
      const script = dockerInstallScript();
      expect(script).toContain('https://get.docker.com');
      expect(script).toContain('curl -fsSL');
    });

    it('enables and starts the docker systemd service', () => {
      const script = dockerInstallScript();
      expect(script).toContain('systemctl enable docker');
      expect(script).toContain('systemctl start docker');
    });

    it('adds invoking user to docker group (best-effort)', () => {
      const script = dockerInstallScript();
      expect(script).toContain('usermod -aG docker');
    });

    it('verifies the install via sudo docker compose version', () => {
      const script = dockerInstallScript();
      // Verification must use sudo because the group change isn't effective in
      // the current session — the docs explicitly call this out.
      expect(script).toContain('sudo docker --version');
      expect(script).toContain('sudo docker compose version');
    });
  });

  // ==================== sysctlScript ====================
  describe('sysctlScript', () => {
    it('writes /etc/sysctl.d/99-bridgeport.conf', () => {
      const script = sysctlScript();
      expect(script).toContain('/etc/sysctl.d/99-bridgeport.conf');
    });

    it('includes vm.swappiness=10 and fs.file-max=2097152', () => {
      const script = sysctlScript();
      expect(script).toContain('vm.swappiness=10');
      expect(script).toContain('fs.file-max=2097152');
    });

    it('uses a heredoc so static content is not subject to shell parsing', () => {
      const script = sysctlScript();
      expect(script).toContain("<<'BRIDGEPORT_SYSCTL_EOF'");
      expect(script).toContain('BRIDGEPORT_SYSCTL_EOF');
    });

    it('reloads sysctl via `sysctl --system`', () => {
      expect(sysctlScript()).toContain('sudo sysctl --system');
    });

    it('verifies the drop-in file exists after writing (idempotency probe)', () => {
      // Without this probe a silent write failure (e.g. read-only /etc) could
      // leave bootstrap thinking sysctl succeeded.
      expect(sysctlScript()).toContain('[ -f /etc/sysctl.d/99-bridgeport.conf ]');
    });
  });

  // ==================== swapScript ====================
  describe('swapScript', () => {
    it('shell-escapes the swap size argument', () => {
      // Even though sizeMb is typed `number`, the implementation explicitly
      // routes it through shellEscape so a future refactor that widens the
      // type stays safe. Verify the escape is applied.
      const script = swapScript(1024);
      // shellEscape wraps in single quotes.
      expect(script).toContain("SIZE_MB='1024'");
    });

    it('skips creation when /swapfile is already active', () => {
      const script = swapScript(512);
      // The leading probe must match the swapon --show output format exactly
      // (trailing space avoids matching "/swapfile2").
      expect(script).toContain('swapon --show 2>/dev/null | grep -q "^/swapfile "');
    });

    it('uses fallocate with dd as a portable fallback', () => {
      const script = swapScript(2048);
      expect(script).toContain('fallocate -l');
      expect(script).toContain('dd if=/dev/zero');
    });

    it('runs mkswap and swapon on the new file', () => {
      const script = swapScript(1024);
      expect(script).toContain('mkswap /swapfile');
      expect(script).toContain('swapon /swapfile');
    });

    it('chmods /swapfile to 0600 before activating', () => {
      // mkswap will refuse insecure perms; we must chmod 600 first.
      expect(swapScript(1024)).toContain('chmod 600 /swapfile');
    });

    it('backs up /etc/fstab once to /etc/fstab.bridgeport.bak', () => {
      const script = swapScript(1024);
      // Backup must be gated by a "first time" check so re-runs don't clobber
      // the original backup.
      expect(script).toContain('[ ! -f /etc/fstab.bridgeport.bak ]');
      expect(script).toContain('cp /etc/fstab /etc/fstab.bridgeport.bak');
    });

    it('appends fstab line only if /swapfile is not already mounted (awk first-field match)', () => {
      const script = swapScript(1024);
      // First-field awk match tolerates whitespace variants and existing
      // entries with different mount options ("swap" type, "defaults" opts,
      // tab-separated). Anchored grep -qxF would false-negative those cases
      // and append a duplicate line.
      expect(script).toContain('awk \'$1=="/swapfile" {found=1} END{exit !found}\' /etc/fstab');
      expect(script).toContain("FSTAB_LINE='/swapfile none swap sw 0 0'");
    });

    it('verifies swap is active at the end', () => {
      // Final probe so a silent failure doesn't report success.
      expect(swapScript(1024)).toContain('swapon --show | grep -q /swapfile');
    });
  });
});
