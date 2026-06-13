import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getMcpStatus, type McpStatus, type McpToolMetadata } from '../../lib/api';
import { useToast } from '../../components/Toast';

/**
 * Admin MCP status + operational guidance page (/admin/mcp).
 *
 * Read-only: enable/disable is controlled by the MCP_ENABLED env var (NOT a UI
 * toggle). This page shows whether the server is enabled, how to enable/secure
 * it, how to connect a client, and exactly what tools/resources are exposed.
 */
export default function Mcp() {
  const toast = useToast();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getMcpStatus();
        if (!cancelled) setStatus(res);
      } catch {
        if (!cancelled) toast.error('Failed to load MCP status');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  // The endpoint URL is derived from the browser origin + the server-reported
  // endpoint path (the server doesn't know the public origin clients reach it on).
  const endpointUrl = useMemo(() => {
    if (!status) return '';
    return `${window.location.origin}${status.endpointPath}`;
  }, [status]);

  if (loading) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="animate-pulse space-y-6">
          <div className="h-32 bg-slate-800 rounded-xl" />
          <div className="h-48 bg-slate-800 rounded-xl" />
          <div className="h-64 bg-slate-800 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="card text-center text-slate-400">
          Could not load MCP status. Try refreshing the page.
        </div>
      </div>
    );
  }

  const readTools = status.tools.filter((t) => t.readOnly);
  const writeTools = status.tools.filter((t) => !t.readOnly);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* 1. STATUS */}
      <StatusSection status={status} endpointUrl={endpointUrl} />

      {/* 2. CONNECT A CLIENT */}
      {status.enabled && <ConnectSection endpointUrl={endpointUrl} />}

      {/* 3. EXPOSED SURFACE */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">Exposed tools</h3>
          <span className="text-sm text-slate-400">
            {status.counts.tools} total &middot; {status.counts.readTools} read &middot;{' '}
            {status.counts.writeTools} write
          </span>
        </div>

        <ToolGroup title="Read tools" subtitle="Side-effect-free; available to any valid token." tools={readTools} />
        <div className="mt-6">
          <ToolGroup
            title="Write tools"
            subtitle="Require services:write (operator/admin); destructive-hinted and idempotency-keyed."
            tools={writeTools}
          />
        </div>
      </div>

      <ResourcesSection status={status} />

      {/* 4. SAFETY / DATA EGRESS */}
      <SafetySection />
    </div>
  );
}

function StatusSection({ status, endpointUrl }: { status: McpStatus; endpointUrl: string }) {
  const dns = status.dnsRebindingProtection;
  return (
    <div className="card">
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-lg font-semibold text-white">MCP server</h3>
        <span className={`badge ${status.enabled ? 'badge-success' : 'badge-neutral'}`}>
          {status.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      {!status.enabled ? (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-200">
          The MCP server is disabled. Set{' '}
          <code className="font-mono bg-slate-950/60 px-1 rounded">MCP_ENABLED=true</code> (and
          restart the container) to enable it. The endpoint is then served at{' '}
          <code className="font-mono bg-slate-950/60 px-1 rounded">{status.endpointPath}</code>. The
          tool and resource inventory below shows exactly what would be exposed.
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="label-xs mb-1">Endpoint URL</div>
            <CopyField value={endpointUrl} />
            <p className="text-xs text-slate-500 mt-1">
              Streamable HTTP transport. Authenticate with{' '}
              <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>.
            </p>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="label-xs">DNS-rebinding protection</span>
              <span className={`badge ${dns.configured ? 'badge-success' : 'badge-warning'}`}>
                {dns.configured ? 'On' : 'Off'}
              </span>
            </div>
            {dns.configured ? (
              <div className="text-sm text-slate-300">
                Restricted to these Host headers:
                <div className="flex flex-wrap gap-1 mt-2">
                  {dns.allowedHosts.map((h) => (
                    <span key={h} className="px-2 py-0.5 bg-slate-700 rounded text-xs text-white font-mono">
                      {h}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-400">
                Protection is off. The endpoint is bearer-authenticated, but for remote or proxied
                clients set{' '}
                <code className="font-mono bg-slate-950/60 px-1 rounded">MCP_ALLOWED_HOSTS</code> to a
                comma-separated list of the public hostname(s) clients reach{' '}
                <code className="font-mono">{status.endpointPath}</code> through (e.g.{' '}
                <code className="font-mono">mcp.example.com</code>) and restart.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectSection({ endpointUrl }: { endpointUrl: string }) {
  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        bridgeport: {
          type: 'http',
          url: endpointUrl,
          headers: { Authorization: 'Bearer <YOUR_TOKEN>' },
        },
      },
    },
    null,
    2
  );

  const cursor = JSON.stringify(
    {
      mcpServers: {
        bridgeport: {
          url: endpointUrl,
          headers: { Authorization: 'Bearer <YOUR_TOKEN>' },
        },
      },
    },
    null,
    2
  );

  const claudeCode = `claude mcp add --transport http bridgeport ${endpointUrl} \\\n  --header "Authorization: Bearer <YOUR_TOKEN>"`;

  return (
    <div className="card space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-white mb-1">Connect a client</h3>
        <p className="text-sm text-slate-400">
          The server is a remote, streamable-HTTP MCP endpoint. Each client config points at the
          endpoint URL with a bearer token. Mint one on the{' '}
          <Link to="/admin/integrations" className="text-primary-400 hover:underline">
            Integrations
          </Link>{' '}
          page (API token or service-account token), then replace{' '}
          <code className="font-mono">&lt;YOUR_TOKEN&gt;</code>. The token's role and environment
          scope determine which tools are available.
        </p>
      </div>

      <CodeBlock label="Claude Desktop (claude_desktop_config.json)" code={claudeDesktop} />
      <CodeBlock label="Cursor (.cursor/mcp.json)" code={cursor} />
      <CodeBlock label="Claude Code (CLI)" code={claudeCode} />
    </div>
  );
}

function ToolGroup({
  title,
  subtitle,
  tools,
}: {
  title: string;
  subtitle: string;
  tools: McpToolMetadata[];
}) {
  return (
    <div>
      <div className="mb-2">
        <h4 className="text-sm font-semibold text-white">
          {title} <span className="text-slate-500 font-normal">({tools.length})</span>
        </h4>
        <p className="text-xs text-slate-500">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700">
              <th className="py-2 pr-3 font-medium">Name</th>
              <th className="py-2 pr-3 font-medium">Description</th>
              <th className="py-2 pr-3 font-medium">Type</th>
              <th className="py-2 pr-3 font-medium">Scope</th>
              <th className="py-2 pr-3 font-medium">Destructive</th>
              <th className="py-2 font-medium">Env-scoped</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.name} className="border-b border-slate-800/60 align-top">
                <td className="py-2 pr-3 font-mono text-xs text-white whitespace-nowrap">{t.name}</td>
                <td className="py-2 pr-3 text-slate-400 min-w-[16rem]">{t.description}</td>
                <td className="py-2 pr-3">
                  <span className={`badge ${t.readOnly ? 'badge-info' : 'badge-warning'}`}>
                    {t.readOnly ? 'read' : 'write'}
                  </span>
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-slate-300 whitespace-nowrap">
                  {t.requiredScope ?? '—'}
                </td>
                <td className="py-2 pr-3">
                  {t.destructive ? <span className="badge badge-error">yes</span> : <span className="text-slate-600">no</span>}
                </td>
                <td className="py-2">
                  {t.envScoped ? <span className="badge badge-neutral">yes</span> : <span className="text-slate-600">no</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResourcesSection({ status }: { status: McpStatus }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Exposed resources</h3>
        <span className="text-sm text-slate-400">{status.counts.resources} total</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700">
              <th className="py-2 pr-3 font-medium">Name</th>
              <th className="py-2 pr-3 font-medium">Description</th>
              <th className="py-2 pr-3 font-medium">URI template</th>
              <th className="py-2 pr-3 font-medium">Scope</th>
              <th className="py-2 font-medium">Env-scoped</th>
            </tr>
          </thead>
          <tbody>
            {status.resources.map((r) => (
              <tr key={r.name} className="border-b border-slate-800/60 align-top">
                <td className="py-2 pr-3 font-mono text-xs text-white whitespace-nowrap">{r.name}</td>
                <td className="py-2 pr-3 text-slate-400 min-w-[16rem]">{r.description}</td>
                <td className="py-2 pr-3 font-mono text-xs text-slate-300 whitespace-nowrap">
                  {r.uriTemplate ?? '—'}
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-slate-300 whitespace-nowrap">
                  {r.requiredScope ?? '—'}
                </td>
                <td className="py-2">
                  {r.envScoped ? <span className="badge badge-neutral">yes</span> : <span className="text-slate-600">no</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SafetySection() {
  return (
    <div className="card">
      <h3 className="text-lg font-semibold text-white mb-3">Safety &amp; data egress</h3>
      <ul className="space-y-2 text-sm text-slate-300 list-disc pl-5">
        <li>
          Tool outputs (especially container logs from{' '}
          <code className="font-mono">get_service_logs</code>) may be sent to whatever model the
          connecting client uses. Treat the endpoint as a data-egress boundary.
        </li>
        <li>
          Secret and credential <strong>values are never returned</strong> — they are redacted at
          the MCP boundary. Tools surface keys, metadata, and{' '}
          <code className="font-mono">hasCredentials</code>-style flags only.
        </li>
        <li>
          Write tools require <code className="font-mono">services:write</code> (operator/admin), are
          destructive-hinted, and inject an <code className="font-mono">Idempotency-Key</code> so a
          retried identical call dedupes rather than re-running.
        </li>
        <li>
          Environment-scoped tokens see a <strong>reduced surface</strong> — only tools and resources
          reachable through their environment's routes are advertised.
        </li>
      </ul>
    </div>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="label-xs">{label}</span>
        <CopyButton value={code} />
      </div>
      <pre className="bg-slate-950 border border-slate-700 rounded p-3 font-mono text-xs text-slate-200 overflow-x-auto whitespace-pre">
        {code}
      </pre>
    </div>
  );
}

function CopyField({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 bg-slate-950 border border-slate-700 rounded p-2 font-mono text-xs text-slate-200 break-all">
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore — clipboard may be unavailable
    }
  }
  return (
    <button type="button" onClick={copy} className="btn btn-ghost text-xs whitespace-nowrap">
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
