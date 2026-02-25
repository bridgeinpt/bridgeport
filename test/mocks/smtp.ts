/**
 * Mock SMTP transport for tests.
 *
 * Captures sent emails in memory for assertion.
 */
import { vi } from 'vitest';

export interface MockEmail {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
}

export function createMockSmtp(): {
  /** The mock sendMail function */
  sendMail: ReturnType<typeof vi.fn>;
  /** All sent emails */
  sentEmails: MockEmail[];
  /** Clear sent email history */
  clear: () => void;
  /** Set sendMail to reject with an error */
  setFailure: (error: string | null) => void;
} {
  const sentEmails: MockEmail[] = [];
  let failure: string | null = null;

  const sendMail = vi.fn(async (options: MockEmail): Promise<{ messageId: string }> => {
    if (failure) {
      throw new Error(failure);
    }
    sentEmails.push(options);
    return { messageId: `test-${Date.now()}-${sentEmails.length}` };
  });

  return {
    sendMail,
    sentEmails,
    clear: () => {
      sentEmails.length = 0;
      sendMail.mockClear();
    },
    setFailure: (error: string | null) => {
      failure = error;
    },
  };
}
