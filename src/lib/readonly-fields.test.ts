import { describe, it, expect } from 'vitest';
import { assertNoReadonlyFields, HINTS_BY_FIELD } from './readonly-fields.js';
import { ApiError } from './errors.js';

/**
 * Unit tests for `assertNoReadonlyFields(model, body)`.
 *
 * Coverage focus (issue #127):
 *  - Atomic rejection: any readonly field in the body throws — there's no
 *    "drop and continue" fallback.
 *  - Error envelope: code = READONLY_FIELD, statusCode = 422, `field`
 *    surfaces the FIRST offender so clients can highlight one input.
 *  - Hints: per-field hint when registered, fallback hint otherwise.
 *  - Defensive guard: non-object bodies pass through so the Zod step can
 *    produce a richer VALIDATION_ERROR.
 */
describe('assertNoReadonlyFields', () => {
  it('throws ApiError(READONLY_FIELD, statusCode=422) when the body names a readonly field', () => {
    expect.assertions(5);
    try {
      // `service.status` is derived from container + URL health checks.
      assertNoReadonlyFields('service', { status: 'healthy' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe('READONLY_FIELD');
      expect(e.statusCode).toBe(422);
      expect(e.field).toBe('status');
      // Single-field message form ("Field … is read-only …").
      expect(e.message).toContain('"status"');
    }
  });

  it('names the FIRST offender in `field` when the body has multiple readonly fields', () => {
    // The implementation iterates Object.keys() in insertion order and surfaces
    // the first match — assert that contract explicitly so callers can rely on
    // single-field error envelopes.
    let caught: ApiError | null = null;
    try {
      assertNoReadonlyFields('service', {
        status: 'healthy',
        exposedPorts: '[]',
        lastCheckedAt: new Date().toISOString(),
      });
    } catch (err) {
      caught = err as ApiError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.field).toBe('status');
    // Multi-field message form lists every offender.
    expect(caught!.message).toContain('"status"');
    expect(caught!.message).toContain('"exposedPorts"');
    expect(caught!.message).toContain('"lastCheckedAt"');
    expect(caught!.message).toContain('read-only');
  });

  it('does not throw when the body has only writable fields', () => {
    // `name` is not in any model's readonly set — proves the function isn't
    // rejecting every body.
    expect(() => assertNoReadonlyFields('service', { name: 'web' })).not.toThrow();
    expect(() => assertNoReadonlyFields('configFile', { name: 'app.env', content: 'X=1' })).not.toThrow();
  });

  it('does not throw on an empty object body', () => {
    expect(() => assertNoReadonlyFields('service', {})).not.toThrow();
  });

  it('defensively passes through non-object bodies (Zod produces the VALIDATION_ERROR)', () => {
    // Letting these through means the downstream `validateBody` / Zod parse
    // step produces a single, well-formed VALIDATION_ERROR envelope instead
    // of competing with this guard.
    expect(() => assertNoReadonlyFields('service', null)).not.toThrow();
    expect(() => assertNoReadonlyFields('service', undefined)).not.toThrow();
    expect(() => assertNoReadonlyFields('service', 'a string')).not.toThrow();
    expect(() => assertNoReadonlyFields('service', 42)).not.toThrow();
    // Arrays are objects in JS but the function treats them as non-objects.
    expect(() => assertNoReadonlyFields('service', ['status'])).not.toThrow();
  });

  it('surfaces the registered per-field hint when one exists', () => {
    expect.assertions(2);
    // `service.exposedPorts` has a HINTS_BY_FIELD entry — the error should
    // carry it verbatim so callers can render actionable guidance.
    const expectedHint = HINTS_BY_FIELD['service.exposedPorts'];
    expect(expectedHint).toBeTruthy();
    try {
      assertNoReadonlyFields('service', { exposedPorts: '[]' });
    } catch (err) {
      expect((err as ApiError).hint).toBe(expectedHint);
    }
  });

  it('falls back to the generic hint when no per-field hint is registered', () => {
    // `service.id` is readonly but has no HINTS_BY_FIELD entry — the fallback
    // `DEFAULT_HINT` should fire so the response is never hint-less.
    expect.assertions(3);
    expect(HINTS_BY_FIELD['service.id']).toBeUndefined();
    try {
      assertNoReadonlyFields('service', { id: 'svc-new' });
    } catch (err) {
      const hint = (err as ApiError).hint;
      expect(hint).toBeTruthy();
      // The generic fallback message lives in `readonly-fields.ts`; assert on
      // a substring so we don't make this test brittle to copy edits.
      expect(hint).toMatch(/derived\/system-managed/);
    }
  });

  it('treats each model registry independently', () => {
    // `key` is readonly on `secret` but NOT on `service` (which has no `key`
    // at all). Both directions matter: model scoping must work.
    expect(() => assertNoReadonlyFields('secret', { key: 'API_KEY' })).toThrow(ApiError);
    expect(() => assertNoReadonlyFields('service', { key: 'whatever' })).not.toThrow();
  });

  it('rejects encrypted-storage fields on the secret model (issue #127)', () => {
    // The whole point of the guard for secrets: callers must set `value`, not
    // `encryptedValue` / `nonce` directly.
    expect.assertions(2);
    try {
      assertNoReadonlyFields('secret', { encryptedValue: 'cafebabe' });
    } catch (err) {
      expect((err as ApiError).field).toBe('encryptedValue');
    }
    try {
      assertNoReadonlyFields('secret', { nonce: 'deadbeef' });
    } catch (err) {
      expect((err as ApiError).field).toBe('nonce');
    }
  });

  it('rejects `metricsMode` on the server model (dedicated endpoint exists)', () => {
    // `server.metricsMode` is in the readonly set because flipping it via the
    // generic PATCH skips the deploy/remove side-effects.
    expect.assertions(2);
    try {
      assertNoReadonlyFields('server', { metricsMode: 'agent' });
    } catch (err) {
      expect((err as ApiError).field).toBe('metricsMode');
      // The hint should mention the dedicated endpoint.
      expect((err as ApiError).hint).toMatch(/metrics-mode/);
    }
  });
});
