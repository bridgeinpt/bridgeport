import { describe, it, expect } from 'vitest';
import { coerceNumeric } from './helpers.js';

describe('coerceNumeric', () => {
  it('converts numeric strings (node-postgres int8/numeric) to numbers', () => {
    expect(coerceNumeric('27917335')).toBe(27917335);
    expect(coerceNumeric('3.09')).toBe(3.09);
    expect(coerceNumeric('-42')).toBe(-42);
    expect(coerceNumeric('  17  ')).toBe(17);
  });

  it('coerces "0" to the number 0 (not treated as empty/falsy)', () => {
    expect(coerceNumeric('0')).toBe(0);
  });

  it('converts bigint to number', () => {
    expect(coerceNumeric(10n)).toBe(10);
  });

  it('leaves genuine numbers untouched', () => {
    expect(coerceNumeric(5)).toBe(5);
    expect(coerceNumeric(0)).toBe(0);
  });

  it('leaves non-numeric text unchanged (table names, versions)', () => {
    expect(coerceNumeric('public.event_entity')).toBe('public.event_entity');
    expect(coerceNumeric('PostgreSQL 15.2')).toBe('PostgreSQL 15.2');
  });

  it('does not coerce empty/whitespace strings to 0', () => {
    expect(coerceNumeric('')).toBe('');
    expect(coerceNumeric('   ')).toBe('   ');
  });

  it('leaves non-finite numeric strings as strings', () => {
    expect(coerceNumeric('Infinity')).toBe('Infinity');
    expect(coerceNumeric('NaN')).toBe('NaN');
  });

  it('passes through null, undefined, objects, and arrays', () => {
    expect(coerceNumeric(null)).toBeNull();
    expect(coerceNumeric(undefined)).toBeUndefined();
    const obj = { a: 1 };
    expect(coerceNumeric(obj)).toBe(obj);
    const arr = [1, 2];
    expect(coerceNumeric(arr)).toBe(arr);
  });
});
