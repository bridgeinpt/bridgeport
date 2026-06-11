import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToOpenApi, routeSchema } from './openapi-schema.js';
// `openapi-schema.ts` itself imports ERROR_ENVELOPE_SCHEMA_ID from this module,
// so referencing it here adds no extra dependency weight and keeps the $ref
// assertions tied to the single source of truth (not a magic string).
import { ERROR_ENVELOPE_SCHEMA_ID } from '../plugins/openapi.js';

describe('zodToOpenApi', () => {
  it('converts a normal Zod object schema to a JSON Schema object', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().int(),
    });

    const result = zodToOpenApi(schema);

    expect(result).toBeDefined();
    expect(result).toMatchObject({ type: 'object' });
    expect(Object.keys(result!.properties as Record<string, unknown>)).toEqual([
      'name',
      'age',
    ]);
  });

  it('returns undefined (does NOT throw) for a non-representable schema', () => {
    // `.transform()` cannot be represented in JSON Schema; z.toJSONSchema THROWS
    // on it. The helper must swallow that and return undefined.
    const schema = z.string().transform((s) => s.length);

    let result: unknown;
    expect(() => {
      result = zodToOpenApi(schema as unknown as z.ZodType);
    }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it('targets OpenAPI 3.0 (inclusive minimum stays a numeric `minimum`, no numeric exclusiveMinimum)', () => {
    // z.number().min(1) is an INCLUSIVE bound. Under the openapi-3.0 target this
    // is the plain `minimum: 1`. The draft-2020-12-only hazard is a *numeric*
    // exclusiveMinimum; assert that never appears here.
    const schema = z.object({ limit: z.number().min(1) });

    const result = zodToOpenApi(schema)!;
    const limit = (result.properties as Record<string, Record<string, unknown>>).limit;

    expect(limit.minimum).toBe(1);
    expect(typeof limit.exclusiveMinimum).not.toBe('number');
  });

  it('targets OpenAPI 3.0 for an EXCLUSIVE bound (boolean exclusiveMinimum form, not draft-2020-12 numeric)', () => {
    // z.number().gt(1) is an EXCLUSIVE bound — the one case where the two JSON
    // Schema dialects genuinely diverge:
    //   OpenAPI 3.0 / draft-4:  { minimum: 1, exclusiveMinimum: true }
    //   draft-2020-12:          { exclusiveMinimum: 1 }
    // Asserting exclusiveMinimum is NOT a number is the robust invariant the
    // 3.0 target guarantees, independent of incidental formatting.
    const schema = z.object({ limit: z.number().gt(1) });

    const result = zodToOpenApi(schema)!;
    const limit = (result.properties as Record<string, Record<string, unknown>>).limit;

    expect(typeof limit.exclusiveMinimum).not.toBe('number');
  });

  it('strips a spurious `additionalProperties: false` (runtime strips unknown keys, contract is open)', () => {
    // Zod's default strip-mode object emits `additionalProperties: false` under
    // OUTPUT semantics; none of our schemas are `.strict()`, so it's spurious.
    const schema = z.object({ name: z.string() });

    const result = zodToOpenApi(schema)!;

    expect(result).not.toHaveProperty('additionalProperties');
  });

  it('preserves `additionalProperties: true` (deliberate open-object marker)', () => {
    const schema = z.object({ name: z.string() }).catchall(z.unknown());

    const result = zodToOpenApi(schema)!;

    expect(result.additionalProperties).not.toBe(false);
  });

  it('strips the bogus Number.MAX_SAFE_INTEGER maximum from one-sided int bounds', () => {
    const schema = z.object({ n: z.number().int().min(0) });

    const result = zodToOpenApi(schema)!;
    const n = (result.properties as Record<string, Record<string, unknown>>).n;

    expect(n.minimum).toBe(0);
    expect(n).not.toHaveProperty('maximum');
  });

  it("with io='input' does NOT mark `.default()` fields as required and omits additionalProperties:false", () => {
    // INPUT semantics model the client's view: defaulted fields are optional and
    // unknown keys are stripped (not rejected). This is the request-body view.
    const schema = z.object({
      page: z.number().int().min(1).default(1),
      name: z.string(),
    });

    const result = zodToOpenApi(schema, 'input')!;

    expect(result.required).toEqual(['name']); // `page` (defaulted) is NOT required
    expect(result).not.toHaveProperty('additionalProperties');
  });

  it("with io='output' marks `.default()` fields as required (server always emits them)", () => {
    const schema = z.object({
      page: z.number().int().min(1).default(1),
      name: z.string(),
    });

    const result = zodToOpenApi(schema, 'output')!;

    // OUTPUT view: a defaulted field is always present on the wire → required.
    expect(result.required).toEqual(expect.arrayContaining(['page', 'name']));
  });

  it('returns undefined (does NOT throw) for a falsy schema argument', () => {
    let result: unknown;
    expect(() => {
      result = zodToOpenApi(undefined as unknown as z.ZodType);
    }).not.toThrow();
    expect(result).toBeUndefined();
  });
});

describe('routeSchema', () => {
  const errorRef = `${ERROR_ENVELOPE_SCHEMA_ID}#`;

  it('assembles body/params/querystring from Zod schemas, each only when provided', () => {
    const schema = routeSchema({
      body: z.object({ name: z.string() }),
      params: z.object({ id: z.string() }),
      querystring: z.object({ limit: z.number() }),
    }) as Record<string, Record<string, unknown>>;

    expect(schema.body).toMatchObject({ type: 'object' });
    expect(Object.keys(schema.body.properties as object)).toEqual(['name']);
    expect(schema.params).toMatchObject({ type: 'object' });
    expect(Object.keys(schema.params.properties as object)).toEqual(['id']);
    expect(schema.querystring).toMatchObject({ type: 'object' });
    expect(Object.keys(schema.querystring.properties as object)).toEqual(['limit']);
  });

  it('omits request fragments that were not provided', () => {
    const schema = routeSchema({ body: z.object({ name: z.string() }) }) as Record<string, unknown>;

    expect(schema).toHaveProperty('body');
    expect(schema).not.toHaveProperty('params');
    expect(schema).not.toHaveProperty('querystring');
  });

  it('passes through tags/summary/description and only sets deprecated when requested', () => {
    const withMeta = routeSchema({
      tags: ['services'],
      summary: 'Do a thing',
      description: 'Long description',
    }) as Record<string, unknown>;

    expect(withMeta.tags).toEqual(['services']);
    expect(withMeta.summary).toBe('Do a thing');
    expect(withMeta.description).toBe('Long description');
    expect(withMeta).not.toHaveProperty('deprecated');

    const deprecated = routeSchema({ deprecated: true }) as Record<string, unknown>;
    expect(deprecated.deprecated).toBe(true);
  });

  it('builds a response map from `errors`, each keyed by code and $ref-ing the ErrorEnvelope', () => {
    const schema = routeSchema({ errors: [400, 404] }) as Record<string, unknown>;
    const responses = schema.response as Record<number, Record<string, unknown>>;

    expect(Object.keys(responses).sort()).toEqual(['400', '404']);

    for (const code of [400, 404]) {
      const content = responses[code].content as Record<string, Record<string, Record<string, unknown>>>;
      expect(content['application/json'].schema.$ref).toBe(errorRef);
    }
  });

  it('does not let `errors` clobber an explicit response entry for the same code', () => {
    const explicit = {
      description: 'Custom 404',
      content: { 'application/json': { schema: { type: 'object' } } },
    };

    const schema = routeSchema({
      response: { 404: explicit },
      errors: [404, 500],
    }) as Record<string, unknown>;
    const responses = schema.response as Record<number, Record<string, unknown>>;

    // The explicit 404 wins; 500 still gets the envelope.
    expect(responses[404]).toEqual(explicit);
    const content500 = responses[500].content as Record<string, Record<string, Record<string, unknown>>>;
    expect(content500['application/json'].schema.$ref).toBe(errorRef);
  });

  it('converts a Zod `response` value and passes a plain-object response through verbatim', () => {
    const plain = {
      description: 'OK',
      content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
    };

    const schema = routeSchema({
      response: {
        200: z.object({ id: z.string() }),
        201: plain,
      },
    }) as Record<string, unknown>;
    const responses = schema.response as Record<number, Record<string, unknown>>;

    // Zod 200 was converted to a JSON Schema object.
    expect(responses[200]).toMatchObject({ type: 'object' });
    expect(Object.keys(responses[200].properties as object)).toEqual(['id']);
    // Plain 201 passed through untouched (same reference).
    expect(responses[201]).toBe(plain);
  });

  it('omits a request fragment entirely when its Zod conversion fails', () => {
    // A `z.custom()` body cannot be represented in JSON Schema (it throws under
    // BOTH input and output semantics — unlike `.transform()`, whose INPUT view
    // resolves to its source type). The helper must omit `body` rather than emit
    // an empty/broken key. Request fragments convert with `io: 'input'`.
    const schema = routeSchema({
      body: z.custom(() => true) as unknown as z.ZodType,
      params: z.object({ id: z.string() }),
    }) as Record<string, unknown>;

    expect(schema).not.toHaveProperty('body');
    // The convertible sibling still made it in.
    expect(schema.params).toMatchObject({ type: 'object' });
  });

  it('omits a `response` entry whose Zod conversion fails (no empty/broken key)', () => {
    const schema = routeSchema({
      response: { 200: z.string().transform((s) => s.length) as unknown as z.ZodType },
    }) as Record<string, unknown>;

    // No convertible responses and no errors → no `response` key at all.
    expect(schema).not.toHaveProperty('response');
  });

  it('returns an empty schema object when given no options', () => {
    expect(routeSchema({})).toEqual({});
  });
});
