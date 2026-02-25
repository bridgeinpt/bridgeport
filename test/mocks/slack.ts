/**
 * Mock Slack webhook client for tests.
 *
 * Captures webhook payloads for assertion.
 */
import { vi } from 'vitest';

export interface MockSlackMessage {
  webhookUrl: string;
  payload: {
    text?: string;
    blocks?: unknown[];
    channel?: string;
    username?: string;
    icon_emoji?: string;
  };
}

export function createMockSlack(): {
  /** The mock send function */
  send: ReturnType<typeof vi.fn>;
  /** All sent messages */
  sentMessages: MockSlackMessage[];
  /** Clear message history */
  clear: () => void;
  /** Set send to reject with an error */
  setFailure: (error: string | null) => void;
} {
  const sentMessages: MockSlackMessage[] = [];
  let failure: string | null = null;

  const send = vi.fn(
    async (webhookUrl: string, payload: MockSlackMessage['payload']): Promise<void> => {
      if (failure) {
        throw new Error(failure);
      }
      sentMessages.push({ webhookUrl, payload });
    }
  );

  return {
    send,
    sentMessages,
    clear: () => {
      sentMessages.length = 0;
      send.mockClear();
    },
    setFailure: (error: string | null) => {
      failure = error;
    },
  };
}
