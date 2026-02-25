/**
 * Mock SSH/Command client for tests.
 *
 * Implements the CommandClient interface from src/lib/ssh.ts.
 * Allows tests to register expected command outputs and control failures.
 */
import { vi } from 'vitest';
import type { CommandClient, SSHExecResult } from '../../src/lib/ssh.js';

export interface MockCommandResponse {
  stdout?: string;
  stderr?: string;
  code?: number;
}

export interface CreateMockSSHOptions {
  /** Default responses for commands (matched by substring) */
  commandResponses?: Record<string, MockCommandResponse>;
  /** Whether connect() should fail */
  connectFailure?: string;
  /** Files written via writeFile() */
  writtenFiles?: Map<string, Buffer>;
}

export function createMockSSH(options: CreateMockSSHOptions = {}): CommandClient & {
  /** Register a command response (matched by substring in command) */
  onCommand: (pattern: string, response: MockCommandResponse) => void;
  /** Get files written via writeFile() */
  writtenFiles: Map<string, Buffer>;
  /** Get all commands that were executed */
  executedCommands: string[];
  /** Mock functions for spying */
  calls: {
    connect: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    execStream: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
} {
  const commandResponses = new Map<string, MockCommandResponse>(
    Object.entries(options.commandResponses || {})
  );
  const writtenFiles = options.writtenFiles || new Map<string, Buffer>();
  const executedCommands: string[] = [];

  const connectFn = vi.fn(async (): Promise<void> => {
    if (options.connectFailure) {
      throw new Error(options.connectFailure);
    }
  });

  const execFn = vi.fn(async (command: string): Promise<SSHExecResult> => {
    executedCommands.push(command);

    // Find matching response by substring match
    for (const [pattern, response] of commandResponses) {
      if (command.includes(pattern)) {
        return {
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
          code: response.code ?? 0,
        };
      }
    }

    // Default: command succeeds with empty output
    return { stdout: '', stderr: '', code: 0 };
  });

  const execStreamFn = vi.fn(
    async (
      command: string,
      onData: (data: string, isStderr: boolean) => void
    ): Promise<number> => {
      executedCommands.push(command);

      // Find matching response
      for (const [pattern, response] of commandResponses) {
        if (command.includes(pattern)) {
          if (response.stdout) onData(response.stdout, false);
          if (response.stderr) onData(response.stderr, true);
          return response.code ?? 0;
        }
      }

      return 0;
    }
  );

  const writeFileFn = vi.fn(
    async (remotePath: string, content: Buffer): Promise<void> => {
      writtenFiles.set(remotePath, content);
    }
  );

  const disconnectFn = vi.fn((): void => {
    // No-op
  });

  return {
    connect: connectFn,
    exec: execFn,
    execStream: execStreamFn,
    writeFile: writeFileFn,
    disconnect: disconnectFn,
    onCommand: (pattern: string, response: MockCommandResponse) => {
      commandResponses.set(pattern, response);
    },
    writtenFiles,
    executedCommands,
    calls: {
      connect: connectFn,
      exec: execFn,
      execStream: execStreamFn,
      writeFile: writeFileFn,
      disconnect: disconnectFn,
    },
  };
}
