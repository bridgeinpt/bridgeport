import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getMcpStatus, type McpStatus, type McpToolMetadata } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { CopyButton } from '@/components/ui/copy-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ShieldAlert } from 'lucide-react';

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
        <div className="space-y-6">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Could not load MCP status. Try refreshing the page.
          </CardContent>
        </Card>
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
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Exposed tools</CardTitle>
          <span className="text-sm text-muted-foreground">
            {status.counts.tools} total &middot; {status.counts.readTools} read &middot;{' '}
            {status.counts.writeTools} write
          </span>
        </CardHeader>
        <CardContent className="space-y-6">
          <ToolGroup
            title="Read tools"
            subtitle="Side-effect-free; available to any valid token."
            tools={readTools}
          />
          <ToolGroup
            title="Write tools"
            subtitle="Require services:write (operator/admin); destructive-hinted and idempotency-keyed."
            tools={writeTools}
          />
        </CardContent>
      </Card>

      <ResourcesSection status={status} />

      {/* 4. SAFETY / DATA EGRESS */}
      <SafetySection />
    </div>
  );
}

function StatusSection({ status, endpointUrl }: { status: McpStatus; endpointUrl: string }) {
  const dns = status.dnsRebindingProtection;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <CardTitle>MCP server</CardTitle>
        <StatusBadge
          kind="server"
          value={status.enabled ? 'healthy' : 'none'}
          label={status.enabled ? 'Enabled' : 'Disabled'}
          variant={status.enabled ? 'success' : 'neutral'}
        />
      </CardHeader>
      <CardContent>
        {!status.enabled ? (
          <Alert variant="warning">
            <ShieldAlert />
            <AlertDescription>
              The MCP server is disabled. Set{' '}
              <code className="font-mono rounded bg-muted px-1">MCP_ENABLED=true</code> (and restart
              the container) to enable it. The endpoint is then served at{' '}
              <code className="font-mono rounded bg-muted px-1">{status.endpointPath}</code>. The
              tool and resource inventory below shows exactly what would be exposed.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">
                Endpoint URL
              </div>
              <CopyField value={endpointUrl} />
              <p className="text-xs text-muted-foreground mt-1">
                Streamable HTTP transport. Authenticate with{' '}
                <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>.
              </p>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  DNS-rebinding protection
                </span>
                <Badge variant={dns.configured ? 'success' : 'warning'}>
                  {dns.configured ? 'On' : 'Off'}
                </Badge>
              </div>
              {dns.configured ? (
                <div className="text-sm text-foreground">
                  Restricted to these Host headers:
                  <div className="flex flex-wrap gap-1 mt-2">
                    {dns.allowedHosts.map((h) => (
                      <span
                        key={h}
                        className="px-2 py-0.5 bg-muted rounded text-xs text-foreground font-mono"
                      >
                        {h}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Protection is off. The endpoint is bearer-authenticated, but for remote or proxied
                  clients set{' '}
                  <code className="font-mono rounded bg-muted px-1">MCP_ALLOWED_HOSTS</code> to a
                  comma-separated list of the public hostname(s) clients reach{' '}
                  <code className="font-mono">{status.endpointPath}</code> through (e.g.{' '}
                  <code className="font-mono">mcp.example.com</code>) and restart.
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>Connect a client</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          The server is a remote, streamable-HTTP MCP endpoint. Each client config points at the
          endpoint URL with a bearer token. Mint one on the{' '}
          <Link to="/admin/integrations" className="text-primary hover:underline">
            Integrations
          </Link>{' '}
          page (API token or service-account token), then replace{' '}
          <code className="font-mono">&lt;YOUR_TOKEN&gt;</code>. The token's role and environment
          scope determine which tools are available.
        </p>

        <CodeBlock label="Claude Desktop (claude_desktop_config.json)" code={claudeDesktop} />
        <CodeBlock label="Cursor (.cursor/mcp.json)" code={cursor} />
        <CodeBlock label="Claude Code (CLI)" code={claudeCode} />
      </CardContent>
    </Card>
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
        <h4 className="text-sm font-semibold text-foreground">
          {title} <span className="text-muted-foreground font-normal">({tools.length})</span>
        </h4>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Destructive</TableHead>
              <TableHead>Env-scoped</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tools.map((t) => (
              <TableRow key={t.name} className="align-top">
                <TableCell className="font-mono text-xs text-foreground whitespace-nowrap">
                  {t.name}
                </TableCell>
                <TableCell className="text-muted-foreground min-w-[16rem]">{t.description}</TableCell>
                <TableCell>
                  <Badge variant={t.readOnly ? 'info' : 'warning'}>
                    {t.readOnly ? 'read' : 'write'}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs text-foreground whitespace-nowrap">
                  {t.requiredScope ?? '—'}
                </TableCell>
                <TableCell>
                  {t.destructive ? (
                    <Badge variant="destructive">yes</Badge>
                  ) : (
                    <span className="text-muted-foreground">no</span>
                  )}
                </TableCell>
                <TableCell>
                  {t.envScoped ? (
                    <Badge variant="neutral">yes</Badge>
                  ) : (
                    <span className="text-muted-foreground">no</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ResourcesSection({ status }: { status: McpStatus }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Exposed resources</CardTitle>
        <span className="text-sm text-muted-foreground">{status.counts.resources} total</span>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>URI template</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Env-scoped</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status.resources.map((r) => (
                <TableRow key={r.name} className="align-top">
                  <TableCell className="font-mono text-xs text-foreground whitespace-nowrap">
                    {r.name}
                  </TableCell>
                  <TableCell className="text-muted-foreground min-w-[16rem]">
                    {r.description}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-foreground whitespace-nowrap">
                    {r.uriTemplate ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-foreground whitespace-nowrap">
                    {r.requiredScope ?? '—'}
                  </TableCell>
                  <TableCell>
                    {r.envScoped ? (
                      <Badge variant="neutral">yes</Badge>
                    ) : (
                      <span className="text-muted-foreground">no</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function SafetySection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Safety &amp; data egress</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm text-foreground list-disc pl-5">
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
            Write tools require <code className="font-mono">services:write</code> (operator/admin),
            are destructive-hinted, and inject an <code className="font-mono">Idempotency-Key</code>{' '}
            so a retried identical call dedupes rather than re-running.
          </li>
          <li>
            Environment-scoped tokens see a <strong>reduced surface</strong> — only tools and
            resources reachable through their environment's routes are advertised.
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <CopyButton value={code} label="Copy" />
      </div>
      <pre className="bg-muted border rounded p-3 font-mono text-xs text-foreground overflow-x-auto whitespace-pre">
        {code}
      </pre>
    </div>
  );
}

function CopyField({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 bg-muted border rounded p-2 font-mono text-xs text-foreground break-all">
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}
