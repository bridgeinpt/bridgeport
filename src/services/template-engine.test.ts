import { describe, it, expect, vi } from 'vitest';
import {
  renderTemplate,
  filterServers,
  parseServerTags,
  type TemplateServer,
  type TemplateServerFilters,
} from './template-engine.js';

const SERVERS: TemplateServer[] = [
  { id: 's1', name: 'api-1', hostname: '10.0.0.1', publicIp: '1.2.3.1', tags: ['web', 'api'], environmentId: 'env-1' },
  { id: 's2', name: 'api-2', hostname: '10.0.0.2', publicIp: null, tags: ['web'], environmentId: 'env-1' },
  { id: 's3', name: 'db-1', hostname: '10.0.0.3', publicIp: '1.2.3.3', tags: ['db'], environmentId: 'env-1' },
  { id: 's4', name: 'staging-api', hostname: '10.0.1.1', publicIp: null, tags: ['web'], environmentId: 'env-2' },
];

function ctx(env = 'env-1') {
  return {
    currentEnvironmentId: env,
    listServers: async (filters: TemplateServerFilters) =>
      filterServers(SERVERS, filters, env),
  };
}

describe('template-engine', () => {
  it('renders an empty set with no error', async () => {
    const { content, errors } = await renderTemplate(
      'before {{range servers tag="nope"}}{{.name}} {{end}}after',
      ctx()
    );
    expect(content).toBe('before after');
    expect(errors).toEqual([]);
  });

  it('iterates servers by tag (alphabetical, deterministic)', async () => {
    const { content, errors } = await renderTemplate(
      '{{range servers tag="web"}}{{.privateIp}}:8000 {{end}}',
      ctx()
    );
    // api-1, api-2 (db-1 is filtered out; staging-api is in env-2)
    expect(content).toBe('10.0.0.1:8000 10.0.0.2:8000 ');
    expect(errors).toEqual([]);
  });

  it('filters by name glob', async () => {
    const { content, errors } = await renderTemplate(
      '{{range servers name="api-*"}}{{.name}}={{.hostname}};{{end}}',
      ctx()
    );
    expect(content).toBe('api-1=10.0.0.1;api-2=10.0.0.2;');
    expect(errors).toEqual([]);
  });

  it('honours cross-environment iteration via environment filter', async () => {
    const { content, errors } = await renderTemplate(
      '{{range servers environment="env-2"}}{{.name}}{{end}}',
      ctx()
    );
    expect(content).toBe('staging-api');
    expect(errors).toEqual([]);
  });

  it('exposes all documented fields, including empty publicIp', async () => {
    const { content, errors } = await renderTemplate(
      '{{range servers name="api-2"}}{{.id}}|{{.name}}|{{.hostname}}|{{.publicIp}}|{{.privateIp}}|{{.tags}}{{end}}',
      ctx()
    );
    expect(content).toBe('s2|api-2|10.0.0.2||10.0.0.2|web');
    expect(errors).toEqual([]);
  });

  it('reports unknown field references without throwing', async () => {
    const { content, errors } = await renderTemplate(
      '{{range servers name="api-1"}}{{.bogus}}{{end}}',
      ctx()
    );
    expect(content).toBe('');
    expect(errors).toEqual(['Unknown field ".bogus" in range body']);
  });

  it('rejects nested {{range}} blocks', async () => {
    const { errors } = await renderTemplate(
      '{{range servers tag="web"}}{{range servers tag="db"}}x{{end}}{{end}}',
      ctx()
    );
    expect(errors.some((e) => /Nested/.test(e))).toBe(true);
  });

  it('reports unclosed range without throwing', async () => {
    const { content, errors } = await renderTemplate(
      'before {{range servers tag="web"}}{{.name}}',
      ctx()
    );
    expect(errors.some((e) => /Unclosed/.test(e))).toBe(true);
    // unterminated content is passed through verbatim
    expect(content).toContain('before ');
  });

  it('leaves non-range {{...}} content untouched (preserves ${KEY} pipeline)', async () => {
    const { content, errors } = await renderTemplate(
      '${DB_URL} and {{NOT_A_RANGE}} text',
      ctx()
    );
    expect(content).toBe('${DB_URL} and {{NOT_A_RANGE}} text');
    expect(errors).toEqual([]);
  });

  it('parseServerTags handles invalid JSON safely', () => {
    expect(parseServerTags('["a","b"]')).toEqual(['a', 'b']);
    expect(parseServerTags('not json')).toEqual([]);
    expect(parseServerTags(null)).toEqual([]);
    expect(parseServerTags('"a"')).toEqual([]);
  });

  it('rejects unknown filter keys', async () => {
    const { errors } = await renderTemplate(
      '{{range servers region="eu"}}x{{end}}',
      ctx()
    );
    expect(errors.some((e) => /Unknown filter/.test(e))).toBe(true);
  });

  // --- expanded coverage ---

  it('emits N concatenated bodies for tag="web" matching multiple servers', async () => {
    // Both api-1 and api-2 carry "web". They are emitted in alphabetical order.
    const { content, errors } = await renderTemplate(
      '{{range servers tag="web"}}{{.name}}\n{{end}}',
      ctx()
    );
    expect(content).toBe('api-1\napi-2\n');
    expect(errors).toEqual([]);
  });

  it('filters by tag exactly (api-1 has both "web" and "api")', async () => {
    // tag="api" must match only api-1, since api-2 doesn't carry "api".
    const { content, errors } = await renderTemplate(
      '{{range servers tag="api"}}{{.name}};{{end}}',
      ctx()
    );
    expect(content).toBe('api-1;');
    expect(errors).toEqual([]);
  });

  it('treats tag filter as exact match, not substring', async () => {
    // No server has the literal tag "we" — even though "web" contains those chars.
    const { content, errors } = await renderTemplate(
      '{{range servers tag="we"}}{{.name}}{{end}}',
      ctx()
    );
    expect(content).toBe('');
    expect(errors).toEqual([]);
  });

  it('name glob with `?` matches a single char only (not multi-char)', async () => {
    const single = [
      { id: 'a', name: 'a-1', hostname: 'h1', publicIp: null, tags: [], environmentId: 'env-1' },
      { id: 'b', name: 'aa-1', hostname: 'h2', publicIp: null, tags: [], environmentId: 'env-1' },
    ];
    const localCtx = {
      currentEnvironmentId: 'env-1',
      listServers: async (filters: TemplateServerFilters) =>
        filterServers(single, filters, 'env-1'),
    };
    const { content, errors } = await renderTemplate(
      '{{range servers name="?-1"}}{{.name}};{{end}}',
      localCtx
    );
    expect(content).toBe('a-1;');
    expect(errors).toEqual([]);
  });

  it('AND-combines multiple filters: tag AND name', async () => {
    // tag="web" AND name="api-*" — db-1 fails the tag, staging-api fails the env.
    // api-1 and api-2 both pass.
    const { content, errors } = await renderTemplate(
      '{{range servers tag="web" name="api-*"}}{{.name}};{{end}}',
      ctx()
    );
    expect(content).toBe('api-1;api-2;');
    expect(errors).toEqual([]);
  });

  it('AND-combines filters: tag AND name with no intersection → empty', async () => {
    // db-1 carries "db" but name doesn't match "api-*". api-* names lack "db".
    const { content, errors } = await renderTemplate(
      '{{range servers tag="db" name="api-*"}}{{.name}};{{end}}',
      ctx()
    );
    expect(content).toBe('');
    expect(errors).toEqual([]);
  });

  it('emits empty string for an unmatched range without error', async () => {
    const { content, errors } = await renderTemplate(
      '<<{{range servers tag="nonexistent"}}{{.name}},{{end}}>>',
      ctx()
    );
    expect(content).toBe('<<>>');
    expect(errors).toEqual([]);
  });

  it('defaults to currentEnvironmentId when no environment filter is given', async () => {
    // Without environment=, the cross-env staging-api should NOT appear.
    const { content, errors } = await renderTemplate(
      '{{range servers tag="web"}}{{.name}};{{end}}',
      ctx('env-1')
    );
    expect(content).toBe('api-1;api-2;');
    expect(content).not.toContain('staging-api');
    expect(errors).toEqual([]);
  });

  it('preserves ${KEY} inside a range body for the secrets layer', async () => {
    const { content, errors } = await renderTemplate(
      '{{range servers tag="web"}}{{.hostname}}:${PORT}\n{{end}}',
      ctx()
    );
    // The `${PORT}` token must pass through verbatim — it is resolved by stage 2.
    expect(content).toBe('10.0.0.1:${PORT}\n10.0.0.2:${PORT}\n');
    expect(errors).toEqual([]);
  });

  it('returns content untouched when no {{range}} token is present', async () => {
    const input = 'plain text\nwith ${VAR} and {{NOT_A_RANGE}} markers\n';
    const { content, errors } = await renderTemplate(input, ctx());
    expect(content).toBe(input);
    expect(errors).toEqual([]);
  });

  it('renders the same input deterministically across repeated runs', async () => {
    const input = '{{range servers tag="web"}}{{.name}}@{{.hostname}};{{end}}';
    const first = await renderTemplate(input, ctx());
    const second = await renderTemplate(input, ctx());
    expect(first.content).toBe(second.content);
    expect(first.errors).toEqual(second.errors);
  });

  it('parses Server.tags JSON via parseServerTags (DB shape)', () => {
    // The schema stores Server.tags as a JSON string. The engine relies on
    // parseServerTags to translate it into a string[] for filtering/rendering.
    expect(parseServerTags(JSON.stringify(['web', 'production']))).toEqual([
      'web',
      'production',
    ]);
  });

  it('parseServerTags drops non-string entries safely', () => {
    expect(parseServerTags('["ok", 42, null, "fine"]')).toEqual(['ok', 'fine']);
  });

  it('passes errors through when listServers throws', async () => {
    const failingCtx = {
      currentEnvironmentId: 'env-1',
      listServers: vi.fn().mockRejectedValue(new Error('db is down')),
    };
    const { content, errors } = await renderTemplate(
      'x {{range servers tag="web"}}{{.name}}{{end}} y',
      failingCtx
    );
    expect(content).toBe('x  y');
    expect(errors.some((e) => /db is down/.test(e))).toBe(true);
  });

  it('records an error and emits nothing for a stray {{end}}', async () => {
    const { content, errors } = await renderTemplate(
      'before {{end}} after',
      ctx()
    );
    // Stray {{end}} is left in place (not interpreted), and recorded as an error.
    expect(content).toContain('before');
    expect(content).toContain('after');
    expect(errors.some((e) => /Unexpected \{\{end\}\}/.test(e))).toBe(true);
  });

  it('renders only `tags` joined by comma', async () => {
    // api-1 has tags ["web","api"] — these must join exactly with comma, no spaces.
    const { content, errors } = await renderTemplate(
      '{{range servers name="api-1"}}[{{.tags}}]{{end}}',
      ctx()
    );
    expect(content).toBe('[web,api]');
    expect(errors).toEqual([]);
  });

  describe('filterServers', () => {
    it('returns servers sorted alphabetically by name', () => {
      const unsorted = [
        { id: 'z', name: 'zeta', hostname: 'h', publicIp: null, tags: [], environmentId: 'e' },
        { id: 'a', name: 'alpha', hostname: 'h', publicIp: null, tags: [], environmentId: 'e' },
        { id: 'm', name: 'mu', hostname: 'h', publicIp: null, tags: [], environmentId: 'e' },
      ];
      const result = filterServers(unsorted, {}, 'e');
      expect(result.map((s) => s.name)).toEqual(['alpha', 'mu', 'zeta']);
    });

    it('skips servers not in the resolved environment', () => {
      const result = filterServers(SERVERS, {}, 'env-1');
      // staging-api lives in env-2 and must be excluded.
      expect(result.find((s) => s.name === 'staging-api')).toBeUndefined();
    });

    it('environment filter overrides currentEnvironmentId', () => {
      const result = filterServers(SERVERS, { environment: 'env-2' }, 'env-1');
      expect(result.map((s) => s.name)).toEqual(['staging-api']);
    });
  });
});
