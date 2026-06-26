import { describe, it, expect, vi } from 'vitest';
import { handlePreloadError } from './preload-error';

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function makeEvent(): Event & { preventDefault: ReturnType<typeof vi.fn> } {
  return { preventDefault: vi.fn() } as unknown as Event & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

describe('handlePreloadError', () => {
  it('reloads once and suppresses Vite default on the first failure', () => {
    const reload = vi.fn();
    const event = makeEvent();
    handlePreloadError(event, { reload, now: () => 1_000, storage: makeStorage() });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('does not reload again within the cooldown (loop guard)', () => {
    const storage = makeStorage();
    const reload = vi.fn();

    handlePreloadError(makeEvent(), { reload, now: () => 1_000, storage });
    // 5s later — still inside the 10s cooldown.
    const second = makeEvent();
    handlePreloadError(second, { reload, now: () => 6_000, storage });

    expect(reload).toHaveBeenCalledTimes(1);
    // Inside the cooldown we let the error surface — don't swallow it.
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it('reloads again once the cooldown has elapsed (later redeploy)', () => {
    const storage = makeStorage();
    const reload = vi.fn();

    handlePreloadError(makeEvent(), { reload, now: () => 1_000, storage });
    // 30s later — well past the cooldown.
    handlePreloadError(makeEvent(), { reload, now: () => 31_000, storage });

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('still reloads when sessionStorage is unavailable', () => {
    const reload = vi.fn();
    const throwingStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;

    handlePreloadError(makeEvent(), { reload, now: () => 1_000, storage: throwingStorage });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
