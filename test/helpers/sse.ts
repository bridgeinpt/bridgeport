/**
 * SSE (Server-Sent Events) response parser for tests.
 *
 * Parses the raw SSE text format into structured event objects.
 */

export interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

/**
 * Parse a raw SSE response body into an array of events.
 *
 * SSE format:
 *   id: 123
 *   event: deployment:step
 *   data: {"stepId": "abc", "status": "running"}
 *
 * Events are separated by double newlines.
 */
export function parseSSEResponse(body: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = body.split('\n\n').filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');
    const event: SSEEvent = { data: '' };
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('id:')) {
        event.id = line.slice(3).trim();
      } else if (line.startsWith('event:')) {
        event.event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      } else if (line.startsWith('retry:')) {
        event.retry = parseInt(line.slice(6).trim(), 10);
      }
    }

    event.data = dataLines.join('\n');
    if (event.data || event.event) {
      events.push(event);
    }
  }

  return events;
}

/**
 * Parse the data field of an SSE event as JSON.
 * Returns null if parsing fails.
 */
export function parseSSEData<T = unknown>(event: SSEEvent): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}
