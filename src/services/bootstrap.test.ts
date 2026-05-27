import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockSSHClientInstance, mockLocalClientInstance, mockLogAudit, mockDeployAgent } =
  vi.hoisted(() => ({
    mockPrisma: {
      server: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    },
    mockSSHClientInstance: {
      connect: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
      execStream: vi.fn().mockResolvedValue(0),
      writeFile: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    },
    mockLocalClientInstance: {
      connect: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
      execStream: vi.fn().mockResolvedValue(0),
      writeFile: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    },
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
    mockDeployAgent: vi.fn().mockResolvedValue({ success: true }),
  }));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/ssh.js', () => ({
  SSHClient: vi.fn().mockImplementation(function () {
    return mockSSHClientInstance;
  }),
  LocalClient: vi.fn().mockImplementation(function () {
    return mockLocalClientInstance;
  }),
  isLocalhost: vi.fn().mockReturnValue(false),
  shellEscape: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
  // Tests always exercise the SSH branch (non-localhost fixture). Returning the
  // SSH mock keeps the existing assertions on mockSSHClientInstance valid.
  createClientForServer: vi.fn().mockImplementation(async () => ({
    client: mockSSHClientInstance,
  })),
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn().mockResolvedValue({
    username: 'root',
    privateKey: 'fake-key',
  }),
}));

vi.mock('./audit.js', () => ({
  logAudit: mockLogAudit,
}));

vi.mock('./agent-deploy.js', () => ({
  deployAgent: mockDeployAgent,
}));

vi.mock('../lib/event-bus.js', () => ({
  eventBus: { emitEvent: vi.fn() },
}));

import {
  detectDistro,
  preflightSudo,
  runBootstrap,
  addSwapLive,
  configureSwap,
  SWAP_MIN_MB,
  SWAP_MAX_MB,
} from './bootstrap.js';

// Default server fixture used across tests.
const fakeServer = {
  id: 'server-1',
  name: 'host-a',
  hostname: '10.0.0.1',
  environmentId: 'env-1',
  bootstrapState: 'not_bootstrapped',
  bootstrapDistro: null,
  dockerInstalled: false,
  sysctlApplied: false,
  swapConfigured: false,
};

describe('bootstrap service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to neutral defaults so individual tests opt in to behaviour.
    mockSSHClientInstance.connect.mockResolvedValue(undefined);
    mockSSHClientInstance.exec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    mockSSHClientInstance.execStream.mockResolvedValue(0);
    mockLocalClientInstance.exec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    mockLocalClientInstance.execStream.mockResolvedValue(0);
    mockPrisma.server.findUnique.mockResolvedValue(fakeServer);
    mockPrisma.server.update.mockResolvedValue(fakeServer);
    mockDeployAgent.mockResolvedValue({ success: true });
  });

  // ==================== detectDistro ====================
  describe('detectDistro', () => {
    it('returns supported=true for ubuntu', async () => {
      mockSSHClientInstance.exec.mockResolvedValueOnce({
        code: 0,
        stdout: 'ubuntu:22.04\n',
        stderr: '',
      });

      const result = await detectDistro(mockSSHClientInstance as any, 'server-1');

      expect(result).toEqual({ distro: 'ubuntu', supported: true, raw: 'ubuntu:22.04' });
      // Side effect: caches the raw value on the server row.
      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: 'server-1' },
        data: { bootstrapDistro: 'ubuntu:22.04' },
      });
    });

    it('returns supported=true for debian', async () => {
      mockSSHClientInstance.exec.mockResolvedValueOnce({
        code: 0,
        stdout: 'debian:12\n',
        stderr: '',
      });

      const result = await detectDistro(mockSSHClientInstance as any, 'server-1');

      expect(result.supported).toBe(true);
      expect(result.distro).toBe('debian');
    });

    it('returns supported=false for rocky/alma', async () => {
      mockSSHClientInstance.exec.mockResolvedValueOnce({
        code: 0,
        stdout: 'rocky:9.3\n',
        stderr: '',
      });

      const result = await detectDistro(mockSSHClientInstance as any, 'server-1');

      expect(result.supported).toBe(false);
      expect(result.distro).toBe('rocky');
    });

    it('returns distro=null when /etc/os-release is missing', async () => {
      mockSSHClientInstance.exec.mockResolvedValueOnce({
        code: 0,
        stdout: '\n',
        stderr: '',
      });

      const result = await detectDistro(mockSSHClientInstance as any, 'server-1');

      expect(result).toEqual({ distro: null, supported: false, raw: '' });
      // No cache update on empty output.
      expect(mockPrisma.server.update).not.toHaveBeenCalled();
    });
  });

  // ==================== preflightSudo ====================
  describe('preflightSudo', () => {
    it('passes when sudo -n true exits 0', async () => {
      mockSSHClientInstance.exec.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

      const result = await preflightSudo(mockSSHClientInstance as any);

      expect(result).toEqual({ ok: true });
    });

    it('returns an actionable error when sudo prompts for a password', async () => {
      mockSSHClientInstance.exec.mockResolvedValueOnce({
        code: 1,
        stdout: '',
        stderr: 'sudo: a password is required',
      });

      const result = await preflightSudo(mockSSHClientInstance as any);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/passwordless sudo/i);
      expect(result.error).toMatch(/NOPASSWD/);
    });

    it('returns an actionable error when sudo complains about TTY', async () => {
      // Some sudo versions emit "sudo: a terminal is required" instead of
      // mentioning passwords directly. Both must surface the same actionable
      // remediation.
      mockSSHClientInstance.exec.mockResolvedValueOnce({
        code: 1,
        stdout: '',
        stderr: 'sudo: a terminal is required to read the password',
      });

      const result = await preflightSudo(mockSSHClientInstance as any);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/passwordless sudo/i);
    });

    it('falls back to raw combined output for other failures', async () => {
      mockSSHClientInstance.exec.mockResolvedValueOnce({
        code: 1,
        stdout: '',
        stderr: 'sudo: command not found',
      });

      const result = await preflightSudo(mockSSHClientInstance as any);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('sudo: command not found');
    });

    it('falls back to a generic message when stderr/stdout are both empty', async () => {
      mockSSHClientInstance.exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' });

      const result = await preflightSudo(mockSSHClientInstance as any);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('sudo preflight failed');
    });
  });

  // ==================== configureSwap ====================
  describe('configureSwap', () => {
    it('rejects non-integer or out-of-range sizes', async () => {
      const tooSmall = await configureSwap(mockSSHClientInstance as any, SWAP_MIN_MB - 1, () => {});
      expect(tooSmall.success).toBe(false);
      expect(tooSmall.error).toMatch(/outside allowed range/);

      const tooBig = await configureSwap(mockSSHClientInstance as any, SWAP_MAX_MB + 1, () => {});
      expect(tooBig.success).toBe(false);

      const nonInt = await configureSwap(mockSSHClientInstance as any, 1024.5, () => {});
      expect(nonInt.success).toBe(false);
    });

    it('runs the swap script when size is valid', async () => {
      const result = await configureSwap(mockSSHClientInstance as any, 1024, () => {});
      expect(result.success).toBe(true);
      expect(mockSSHClientInstance.execStream).toHaveBeenCalled();
    });

    it('returns failure when the stream exits non-zero', async () => {
      mockSSHClientInstance.execStream.mockResolvedValueOnce(1);

      const result = await configureSwap(mockSSHClientInstance as any, 1024, () => {});

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exited with code 1/);
    });

    it('buffers SSH chunks that split a single log line across callbacks', async () => {
      // Regression for Finding 9: SSH execStream may deliver "[swap] hello\n"
      // as ("[swap] he", "llo\n"). Without buffering we would emit two
      // partial lines instead of one combined line.
      const emittedLines: string[] = [];
      mockSSHClientInstance.execStream.mockImplementationOnce(
        async (_cmd: string, onData: (data: string, isStderr: boolean) => void) => {
          // First chunk: partial line — no newline yet.
          onData('[swap] he', false);
          // Second chunk: completes the first line, includes a complete second.
          onData('llo\n[swap] world\n', false);
          return 0;
        },
      );

      await configureSwap(mockSSHClientInstance as any, 1024, (line) => {
        emittedLines.push(line);
      });

      // Should see exactly two reconstructed lines, NOT four partial fragments.
      expect(emittedLines).toEqual(['[swap] starting (1024MB)', '[swap] hello', '[swap] world']);
    });

    it('flushes a trailing unterminated fragment at stream end', async () => {
      // If the final chunk has no terminating newline the leftover buffer
      // must still surface as a final emitted line.
      const emittedLines: string[] = [];
      mockSSHClientInstance.execStream.mockImplementationOnce(
        async (_cmd: string, onData: (data: string, isStderr: boolean) => void) => {
          onData('[swap] no-newline-at-end', false);
          return 0;
        },
      );

      await configureSwap(mockSSHClientInstance as any, 1024, (line) => {
        emittedLines.push(line);
      });

      // The "[swap] starting" line is logged synchronously before execStream;
      // then the trailing fragment must be flushed exactly once.
      expect(emittedLines).toContain('[swap] no-newline-at-end');
    });
  });

  // ==================== runBootstrap ====================
  describe('runBootstrap', () => {
    function setupSupportedHost() {
      mockSSHClientInstance.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('/etc/os-release')) {
          return { code: 0, stdout: 'ubuntu:22.04\n', stderr: '' };
        }
        if (cmd.includes('sudo -n true')) {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });
    }

    it('returns Server not found when missing', async () => {
      mockPrisma.server.findUnique.mockResolvedValueOnce(null);

      const result = await runBootstrap('missing', { components: { docker: true } });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Server not found');
    });

    it('throws actionable error and marks state=error on unsupported distro', async () => {
      mockSSHClientInstance.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('/etc/os-release')) {
          return { code: 0, stdout: 'rocky:9.3\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await runBootstrap('server-1', { components: { docker: true } });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Unsupported distro/);
      // Server should be flagged as error so the UI surfaces a bad state.
      expect(mockPrisma.server.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { bootstrapState: 'error' } }),
      );
      // Audit log captures failure with success=false.
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'bootstrap', success: false }),
      );
    });

    it('marks state=error on failed sudo preflight', async () => {
      mockSSHClientInstance.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('/etc/os-release')) {
          return { code: 0, stdout: 'ubuntu:22.04\n', stderr: '' };
        }
        if (cmd.includes('sudo -n true')) {
          return { code: 1, stdout: '', stderr: 'sudo: a password is required' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await runBootstrap('server-1', { components: { docker: true } });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/passwordless sudo/i);
      expect(mockPrisma.server.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { bootstrapState: 'error' } }),
      );
      // No install commands should have run.
      expect(mockSSHClientInstance.execStream).not.toHaveBeenCalled();
    });

    it('runs only docker when only docker is selected', async () => {
      setupSupportedHost();

      const result = await runBootstrap('server-1', { components: { docker: true } });

      expect(result.success).toBe(true);
      expect(result.components.docker).toEqual({ success: true });
      expect(result.components.sysctl).toBeUndefined();
      expect(result.components.swap).toBeUndefined();
      expect(result.components.agent).toBeUndefined();
      // Agent deployer must NOT have been invoked.
      expect(mockDeployAgent).not.toHaveBeenCalled();
    });

    it('runs only sysctl when only sysctl is selected', async () => {
      setupSupportedHost();

      const result = await runBootstrap('server-1', { components: { sysctl: true } });

      expect(result.success).toBe(true);
      expect(result.components.sysctl).toEqual({ success: true });
      expect(result.components.docker).toBeUndefined();
      expect(mockDeployAgent).not.toHaveBeenCalled();
    });

    it('runs only swap when only swap is selected (with size)', async () => {
      setupSupportedHost();

      const result = await runBootstrap('server-1', {
        components: { swap: true },
        swapSizeMb: 1024,
      });

      expect(result.success).toBe(true);
      expect(result.components.swap).toEqual({ success: true });
      expect(result.components.docker).toBeUndefined();
    });

    it('fails the swap component when swap is selected but no size provided', async () => {
      setupSupportedHost();

      const result = await runBootstrap('server-1', { components: { swap: true } });

      // Per-component failure shouldn't crash the orchestrator.
      expect(result.success).toBe(false);
      expect(result.components.swap).toEqual({
        success: false,
        error: 'swapSizeMb is required when swap is enabled',
      });
    });

    it('runs all components in correct order: docker → sysctl → swap → agent', async () => {
      setupSupportedHost();

      const execStreamCalls: string[] = [];
      mockSSHClientInstance.execStream.mockImplementation(async (cmd: string) => {
        // First line of each script identifies the component.
        if (cmd.includes('get.docker.com')) execStreamCalls.push('docker');
        else if (cmd.includes('/etc/sysctl.d/99-bridgeport.conf')) execStreamCalls.push('sysctl');
        else if (cmd.includes('/swapfile')) execStreamCalls.push('swap');
        return 0;
      });

      const result = await runBootstrap('server-1', {
        components: { docker: true, sysctl: true, swap: true, agent: true },
        swapSizeMb: 512,
      });

      expect(result.success).toBe(true);
      expect(execStreamCalls).toEqual(['docker', 'sysctl', 'swap']);
      // Agent runs via deployAgent (separate from execStream).
      expect(mockDeployAgent).toHaveBeenCalledWith('server-1');
      // Final state is bootstrapped.
      expect(mockPrisma.server.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { bootstrapState: 'bootstrapped' } }),
      );
      // Successful audit log.
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'bootstrap', success: true }),
      );
    });

    it('marks state=error when any component fails', async () => {
      setupSupportedHost();
      // sysctl succeeds, docker fails.
      mockSSHClientInstance.execStream.mockImplementation(async (cmd: string) => {
        if (cmd.includes('get.docker.com')) return 1; // docker fails
        return 0;
      });

      const result = await runBootstrap('server-1', {
        components: { docker: true, sysctl: true },
      });

      expect(result.success).toBe(false);
      expect(result.components.docker?.success).toBe(false);
      expect(result.components.sysctl?.success).toBe(true);
      expect(mockPrisma.server.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { bootstrapState: 'error' } }),
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'bootstrap', success: false }),
      );
    });

    it('records dockerInstalled timestamp on success', async () => {
      setupSupportedHost();

      await runBootstrap('server-1', { components: { docker: true } });

      const dockerUpdate = mockPrisma.server.update.mock.calls.find(
        (call: any) => call[0].data?.dockerInstalled === true,
      );
      expect(dockerUpdate).toBeDefined();
      expect(dockerUpdate[0].data.dockerInstalledAt).toBeInstanceOf(Date);
    });

    it('records sysctlApplied timestamp on success', async () => {
      setupSupportedHost();

      await runBootstrap('server-1', { components: { sysctl: true } });

      const sysctlUpdate = mockPrisma.server.update.mock.calls.find(
        (call: any) => call[0].data?.sysctlApplied === true,
      );
      expect(sysctlUpdate).toBeDefined();
      expect(sysctlUpdate[0].data.sysctlAppliedAt).toBeInstanceOf(Date);
    });

    it('records swapConfigured + swapSizeMb on success', async () => {
      setupSupportedHost();

      await runBootstrap('server-1', { components: { swap: true }, swapSizeMb: 2048 });

      const swapUpdate = mockPrisma.server.update.mock.calls.find(
        (call: any) => call[0].data?.swapConfigured === true,
      );
      expect(swapUpdate).toBeDefined();
      expect(swapUpdate[0].data.swapSizeMb).toBe(2048);
    });

    it('records agentInstalledAt only after deployAgent succeeds', async () => {
      setupSupportedHost();

      await runBootstrap('server-1', { components: { agent: true } });

      const agentUpdate = mockPrisma.server.update.mock.calls.find(
        (call: any) => call[0].data?.agentInstalledAt,
      );
      expect(agentUpdate).toBeDefined();
    });

    it('does not record agentInstalledAt when deployAgent fails', async () => {
      setupSupportedHost();
      mockDeployAgent.mockResolvedValueOnce({ success: false, error: 'agent timeout' });

      const result = await runBootstrap('server-1', { components: { agent: true } });

      expect(result.success).toBe(false);
      expect(result.components.agent?.success).toBe(false);
      const agentUpdate = mockPrisma.server.update.mock.calls.find(
        (call: any) => call[0].data?.agentInstalledAt,
      );
      expect(agentUpdate).toBeUndefined();
    });
  });

  // ==================== addSwapLive ====================
  describe('addSwapLive', () => {
    it('returns Server not found when missing', async () => {
      mockPrisma.server.findUnique.mockResolvedValueOnce(null);

      const result = await addSwapLive('missing', 1024);

      expect(result).toEqual({ success: false, error: 'Server not found' });
    });

    it('rejects when swap already on and force is not set', async () => {
      // Sequence: free -m (before), swapon --show (already on)
      mockSSHClientInstance.exec
        .mockResolvedValueOnce({ code: 0, stdout: 'before-mem', stderr: '' }) // free -m before
        .mockResolvedValueOnce({
          code: 0,
          stdout: 'NAME      TYPE  SIZE\n/swapfile file  1024M',
          stderr: '',
        }); // swapon --show

      const result = await addSwapLive('server-1', 1024);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already present/i);
      expect(result.before).toBe('before-mem');
      // Should NOT have run the configureSwap stream.
      expect(mockSSHClientInstance.execStream).not.toHaveBeenCalled();
    });

    it('does not false-positive on /swapfile.bak in swapon output', async () => {
      // Regression: substring `includes('/swapfile')` would have wrongly
      // matched a stale `/swapfile.bak` entry. The new anchored regex
      // (`/^\/swapfile\s/m`) must reject it so we proceed with the install.
      mockSSHClientInstance.exec.mockImplementation(async (cmd: string) => {
        if (cmd === 'free -m') return { code: 0, stdout: 'mem', stderr: '' };
        if (cmd.includes('swapon --show')) {
          // No real /swapfile, but a backup file path mentions the string.
          return {
            code: 0,
            stdout: 'NAME             TYPE  SIZE\n/swapfile.bak    file  1024M',
            stderr: '',
          };
        }
        if (cmd.includes('sudo -n true')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await addSwapLive('server-1', 1024);

      // Must proceed to install (no false-positive abort).
      expect(result.success).toBe(true);
      expect(mockSSHClientInstance.execStream).toHaveBeenCalled();
    });

    it('proceeds when swap already on but force=true', async () => {
      // Sequence: free -m, sudo preflight, free -m after
      mockSSHClientInstance.exec.mockImplementation(async (cmd: string) => {
        if (cmd === 'free -m') {
          return { code: 0, stdout: 'mem-snapshot', stderr: '' };
        }
        if (cmd.includes('sudo -n true')) {
          return { code: 0, stdout: '', stderr: '' };
        }
        if (cmd.includes('swapon --show')) {
          return { code: 0, stdout: '/swapfile already present', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await addSwapLive('server-1', 1024, { force: true });

      expect(result.success).toBe(true);
      // Swap script must have run.
      expect(mockSSHClientInstance.execStream).toHaveBeenCalled();
      // Audit log on success.
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'configure_swap',
          success: true,
          details: expect.objectContaining({ sizeMb: 1024, force: true }),
        }),
      );
    });

    it('rejects when sudo preflight fails', async () => {
      mockSSHClientInstance.exec.mockImplementation(async (cmd: string) => {
        if (cmd === 'free -m') return { code: 0, stdout: '', stderr: '' };
        if (cmd.includes('swapon --show')) return { code: 0, stdout: '', stderr: '' };
        if (cmd.includes('sudo -n true')) {
          return { code: 1, stdout: '', stderr: 'sudo: a password is required' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await addSwapLive('server-1', 1024);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/passwordless sudo/i);
      expect(mockSSHClientInstance.execStream).not.toHaveBeenCalled();
    });

    it('updates server fields on success', async () => {
      mockSSHClientInstance.exec.mockImplementation(async (cmd: string) => {
        if (cmd === 'free -m') return { code: 0, stdout: 'mem', stderr: '' };
        if (cmd.includes('swapon --show')) return { code: 0, stdout: '', stderr: '' };
        if (cmd.includes('sudo -n true')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      });

      await addSwapLive('server-1', 2048);

      const swapUpdate = mockPrisma.server.update.mock.calls.find(
        (call: any) => call[0].data?.swapConfigured === true,
      );
      expect(swapUpdate).toBeDefined();
      expect(swapUpdate[0].data.swapSizeMb).toBe(2048);
    });

    it('logs audit with success=false when configureSwap fails', async () => {
      mockSSHClientInstance.exec.mockImplementation(async (cmd: string) => {
        if (cmd === 'free -m') return { code: 0, stdout: 'mem', stderr: '' };
        if (cmd.includes('swapon --show')) return { code: 0, stdout: '', stderr: '' };
        if (cmd.includes('sudo -n true')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      });
      mockSSHClientInstance.execStream.mockResolvedValueOnce(1); // swap script fails

      const result = await addSwapLive('server-1', 1024);

      expect(result.success).toBe(false);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'configure_swap', success: false }),
      );
    });
  });
});
