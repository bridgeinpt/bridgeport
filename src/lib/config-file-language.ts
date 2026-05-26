/**
 * Map a filename to a syntax-highlighting language hint used by the
 * config-file editor (CodeMirror in the UI). This is intentionally a
 * server-side concern so that newly created config files get a sensible
 * default `language` without the client having to opt in.
 *
 * The set of returned values is the public contract: the UI maps each one
 * to a CodeMirror language pack. Add new values here when adding new packs
 * on the UI side.
 *
 * Unknown extensions fall back to `"plaintext"`.
 */

const EXACT_NAME_MAP: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Caddyfile: 'nginx',
  'nginx.conf': 'nginx',
  Makefile: 'plaintext',
};

const EXTENSION_MAP: Record<string, string> = {
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  env: 'env',
  toml: 'toml',
  ini: 'ini',
  conf: 'conf',
  cnf: 'conf',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  dockerfile: 'dockerfile',
};

/**
 * Detect the syntax-highlighting language for a config-file filename.
 *
 * Examples:
 *   detectLanguage("docker-compose.yml")    // "yaml"
 *   detectLanguage("config.json")           // "json"
 *   detectLanguage("Dockerfile")            // "dockerfile"
 *   detectLanguage(".env.production")       // "env"
 *   detectLanguage("Caddyfile")             // "nginx"
 *   detectLanguage("nginx.conf")            // "nginx"
 *   detectLanguage("readme.txt")            // "plaintext"
 */
export function detectLanguage(filename: string): string {
  if (!filename) return 'plaintext';

  // Strip a leading directory if a path was passed.
  const base = filename.split(/[\\/]/).pop() ?? filename;

  // Exact-name match takes precedence (Dockerfile, Caddyfile, nginx.conf, ...)
  if (EXACT_NAME_MAP[base]) return EXACT_NAME_MAP[base];

  // Dotfile shortcuts: .env, .env.production, .env.local
  if (base.startsWith('.env')) return 'env';

  // Compound filename shortcuts. Things like `Dockerfile.dev`,
  // `nginx.conf.template`, `Caddyfile-prod` are recognizable by their prefix
  // even though they don't match the exact-name map. Match these before the
  // generic extension lookup since the extension would otherwise win.
  if (/^Dockerfile[.-]/.test(base)) return 'dockerfile';
  if (/^nginx\.conf[.-]/.test(base)) return 'nginx';
  if (/^Caddyfile[.-]/.test(base)) return 'nginx';

  // Template wrappers: strip `.template` or `.j2` and recurse on the inner
  // filename. E.g. `nginx.conf.template` -> `nginx.conf` -> 'nginx',
  // `compose.yml.j2` -> `compose.yml` -> 'yaml'.
  if (/\.(template|j2)$/i.test(base)) {
    const stripped = base.replace(/\.(template|j2)$/i, '');
    if (stripped) return detectLanguage(stripped);
  }

  // Extension-based detection. Use the last `.` segment.
  const dot = base.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const ext = base.slice(dot + 1).toLowerCase();
  return EXTENSION_MAP[ext] ?? 'plaintext';
}
