import { describe, it, expect } from 'vitest';
import {
  ApiError,
  codeForStatus,
  envelopeFromApiError,
  statusForCode,
} from './errors.js';

describe('errors', () => {
  describe('statusForCode', () => {
    it('maps each ErrorCode to its canonical HTTP status', () => {
      expect(statusForCode('VALIDATION_ERROR')).toBe(400);
      // 422 (Unprocessable Entity) per issue #127 — the request is syntactically
      // valid but names a derived/system-managed field that can't be PATCHed.
      expect(statusForCode('READONLY_FIELD')).toBe(422);
      expect(statusForCode('UNAUTHORIZED')).toBe(401);
      expect(statusForCode('FORBIDDEN_SCOPE')).toBe(403);
      expect(statusForCode('NOT_FOUND')).toBe(404);
      expect(statusForCode('CONFLICT')).toBe(409);
      expect(statusForCode('IDEMPOTENCY_KEY_REUSED')).toBe(409);
      expect(statusForCode('RATE_LIMITED')).toBe(429);
      expect(statusForCode('INTERNAL')).toBe(500);
    });
  });

  describe('codeForStatus', () => {
    it('maps common HTTP statuses to the expected ErrorCode', () => {
      expect(codeForStatus(400)).toBe('VALIDATION_ERROR');
      expect(codeForStatus(401)).toBe('UNAUTHORIZED');
      expect(codeForStatus(403)).toBe('FORBIDDEN_SCOPE');
      expect(codeForStatus(404)).toBe('NOT_FOUND');
      expect(codeForStatus(409)).toBe('CONFLICT');
      expect(codeForStatus(429)).toBe('RATE_LIMITED');
      expect(codeForStatus(500)).toBe('INTERNAL');
      expect(codeForStatus(503)).toBe('INTERNAL');
    });

    it('treats unknown 4xx as VALIDATION_ERROR', () => {
      expect(codeForStatus(418)).toBe('VALIDATION_ERROR');
      expect(codeForStatus(422)).toBe('VALIDATION_ERROR');
    });

    it('falls back to INTERNAL for non-error statuses', () => {
      expect(codeForStatus(200)).toBe('INTERNAL');
      expect(codeForStatus(0)).toBe('INTERNAL');
    });
  });

  describe('ApiError', () => {
    it('defaults statusCode based on the code', () => {
      const err = new ApiError('NOT_FOUND', 'Service not found');
      expect(err.code).toBe('NOT_FOUND');
      expect(err.statusCode).toBe(404);
      expect(err.message).toBe('Service not found');
      expect(err.field).toBeUndefined();
      expect(err.hint).toBeUndefined();
    });

    it('preserves optional field and hint', () => {
      const err = new ApiError('VALIDATION_ERROR', 'Invalid', {
        field: 'password',
        hint: 'Must be at least 8 characters',
      });
      expect(err.field).toBe('password');
      expect(err.hint).toBe('Must be at least 8 characters');
    });

    it('allows overriding the statusCode', () => {
      const err = new ApiError('VALIDATION_ERROR', 'Unprocessable', {
        statusCode: 422,
      });
      expect(err.statusCode).toBe(422);
      expect(err.code).toBe('VALIDATION_ERROR');
    });

    it('is an instance of Error and has the expected name', () => {
      const err = new ApiError('INTERNAL', 'boom');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ApiError');
    });

    it('preserves cause when provided', () => {
      const cause = new Error('underlying');
      const err = new ApiError('INTERNAL', 'wrapper', { cause });
      expect((err as Error & { cause?: unknown }).cause).toBe(cause);
    });
  });

  describe('envelopeFromApiError', () => {
    it('returns a minimal envelope when no optional fields are set', () => {
      const env = envelopeFromApiError(new ApiError('NOT_FOUND', 'gone'));
      expect(env).toEqual({ code: 'NOT_FOUND', message: 'gone' });
    });

    it('includes field and hint when present', () => {
      const env = envelopeFromApiError(
        new ApiError('VALIDATION_ERROR', 'bad', {
          field: 'email',
          hint: 'Must be a valid email',
        })
      );
      expect(env).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'bad',
        field: 'email',
        hint: 'Must be a valid email',
      });
    });

    it('omits requestId (added by the handler)', () => {
      const env = envelopeFromApiError(new ApiError('CONFLICT', 'dup'));
      expect(env).not.toHaveProperty('requestId');
    });
  });
});
