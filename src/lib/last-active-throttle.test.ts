import { describe, it, expect } from 'vitest';
import { createThrottle } from './last-active-throttle.js';

describe('last-active-throttle', () => {
  it('lets the first write per id through', () => {
    const t = createThrottle({ windowMs: 60_000 });
    expect(t.shouldWrite('a')).toBe(true);
    expect(t.shouldWrite('b')).toBe(true);
  });

  it('blocks subsequent writes within the window', () => {
    const t = createThrottle({ windowMs: 60_000 });
    const now = 1_000_000;
    expect(t.shouldWrite('a', now)).toBe(true);
    expect(t.shouldWrite('a', now + 10)).toBe(false);
    expect(t.shouldWrite('a', now + 59_999)).toBe(false);
  });

  it('allows writes once the window has elapsed', () => {
    const t = createThrottle({ windowMs: 60_000 });
    const now = 1_000_000;
    expect(t.shouldWrite('a', now)).toBe(true);
    expect(t.shouldWrite('a', now + 60_001)).toBe(true);
  });

  it('throttles independently per id', () => {
    const t = createThrottle({ windowMs: 60_000 });
    const now = 1_000_000;
    expect(t.shouldWrite('a', now)).toBe(true);
    expect(t.shouldWrite('b', now)).toBe(true);
    expect(t.shouldWrite('a', now + 100)).toBe(false);
    expect(t.shouldWrite('b', now + 100)).toBe(false);
  });

  it('evicts oldest entries when maxEntries is exceeded', () => {
    const t = createThrottle({ windowMs: 60_000, maxEntries: 4 });
    for (let i = 0; i < 4; i++) t.shouldWrite(`id-${i}`, 1000 + i);
    expect(t.size()).toBe(4);

    // Adding a 5th triggers eviction of the oldest ~half.
    t.shouldWrite('id-4', 2000);
    expect(t.size()).toBeLessThan(5);
    // The oldest entries should be gone; recently-used ones survive.
    expect(t.shouldWrite('id-0', 2001)).toBe(true);
    expect(t.shouldWrite('id-4', 2002)).toBe(false);
  });

  it('reset() clears all state', () => {
    const t = createThrottle({ windowMs: 60_000 });
    t.shouldWrite('a');
    t.shouldWrite('b');
    expect(t.size()).toBe(2);
    t.reset();
    expect(t.size()).toBe(0);
    expect(t.shouldWrite('a')).toBe(true);
  });
});
