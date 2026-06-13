/**
 * Unit tests for the MCP secret-redactor (FIX 1).
 *
 * Pure logic: the redactor strips secret-named keys recursively while preserving
 * the non-secret presence metadata (hasToken/hasPassword/…/tokenPrefix) that the
 * safe API projections advertise as their contract.
 */
import { describe, it, expect } from 'vitest';
import { redactSensitive, isSecretKey } from './redact.js';

describe('isSecretKey', () => {
  it('matches the exact secret-column denylist from the schema', () => {
    for (const key of [
      'sshPrivateKey',
      'agentToken',
      'tokenHash',
      'encryptedValue',
      'nonce',
      'encryptedToken',
      'tokenNonce',
      'encryptedPassword',
      'passwordNonce',
      'encryptedCredentials',
      'credentialsNonce',
      'encryptedSecret',
      'secretNonce',
      'encryptedSecretKey',
      'secretKeyNonce',
      'webhookUrlNonce',
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it('matches the shape patterns (^encrypted, *Nonce) for future columns', () => {
    expect(isSecretKey('encryptedAnythingNew')).toBe(true);
    expect(isSecretKey('someFutureNonce')).toBe(true);
    expect(isSecretKey('Nonce')).toBe(true);
  });

  it('does NOT match non-secret presence metadata or ordinary fields', () => {
    for (const key of [
      'hasToken',
      'hasPassword',
      'hasSecret',
      'hasCredentials',
      'tokenPrefix',
      'id',
      'name',
      'username',
      'registryUrl',
      'hostname',
    ]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe('redactSensitive', () => {
  it('strips secret keys at the top level, keeps the rest', () => {
    const out = redactSensitive({
      id: 'x',
      sshPrivateKey: 'nonce:cipher',
      agentToken: 'tok',
      name: 'env',
    });
    expect(out).toEqual({ id: 'x', name: 'env' });
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactSensitive({
      service: {
        environment: { id: 'e1', sshPrivateKey: 'secret' },
        deployments: [
          { id: 'd1', server: { id: 's1', agentToken: 'a', hostname: 'h' } },
          { id: 'd2', server: { id: 's2', agentToken: 'b', hostname: 'h2' } },
        ],
        containerImage: {
          registryConnection: { id: 'r1', encryptedToken: 'ct', tokenNonce: 'n', hasToken: true },
        },
      },
    });
    expect(out).toEqual({
      service: {
        environment: { id: 'e1' },
        deployments: [
          { id: 'd1', server: { id: 's1', hostname: 'h' } },
          { id: 'd2', server: { id: 's2', hostname: 'h2' } },
        ],
        containerImage: {
          registryConnection: { id: 'r1', hasToken: true },
        },
      },
    });
  });

  it('preserves non-secret presence booleans and tokenPrefix (no over-stripping)', () => {
    const out = redactSensitive({
      registry: { hasToken: true, hasPassword: false, username: 'u', encryptedToken: 'x' },
      token: { tokenPrefix: 'bport_pat_a1b2', tokenHash: 'deadbeef' },
      db: { hasCredentials: true, encryptedCredentials: 'cc', credentialsNonce: 'nn' },
      webhook: { hasSecret: true, encryptedSecret: 'es', secretNonce: 'sn' },
    });
    expect(out).toEqual({
      registry: { hasToken: true, hasPassword: false, username: 'u' },
      token: { tokenPrefix: 'bport_pat_a1b2' },
      db: { hasCredentials: true },
      webhook: { hasSecret: true },
    });
  });

  it('passes primitives, null, and Dates through unchanged', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive('s')).toBe('s');
    expect(redactSensitive(null)).toBe(null);
    expect(redactSensitive(d)).toBe(d);
    expect(redactSensitive({ at: d, n: 1 })).toEqual({ at: d, n: 1 });
  });

  it('does not mutate the input', () => {
    const input = { id: 'x', sshPrivateKey: 'secret' };
    redactSensitive(input);
    expect(input).toEqual({ id: 'x', sshPrivateKey: 'secret' });
  });
});
