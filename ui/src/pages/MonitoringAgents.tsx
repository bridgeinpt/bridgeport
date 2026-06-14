import { Fragment, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getAgents,
  getAgentEvents,
  testAllSSH,
  testServerSSH,
  updateServerMetricsMode,
  regenerateAgentToken,
  removeAgent,
  deployAgent,
  type AgentInfo,
  type AgentEvent,
  type MetricsMode,
  type AgentStatus,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConfirm } from '@/hooks/useConfirm';
import { type StatusVariant } from '@/lib/status';
import { cn } from '@/lib/utils';

type TabType = 'ssh' | 'agents';

export default function MonitoringAgents() {
  const { selectedEnvironment, autoRefreshEnabled, setAutoRefreshEnabled } = useAppStore();
  const location = useLocation();
  const navigate = useNavigate();
  const confirm = useConfirm();

  // Get tab from URL hash, default to 'ssh'
  const getTabFromHash = (): TabType => {
    const hash = location.hash.replace('#', '');
    return hash === 'agents' ? 'agents' : 'ssh';
  };

  const [sshUser, setSshUser] = useState('root');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [bundledAgentVersion, setBundledAgentVersion] = useState<string>('unknown');
  const [loading, setLoading] = useState(true);
  const [testingAll, setTestingAll] = useState(false);
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; durationMs: number; error?: string }>>({});
  const [changingMode, setChangingMode] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const activeTab = getTabFromHash();

  const setActiveTab = (tab: TabType) => {
    navigate({ hash: tab }, { replace: true });
  };

  const fetchData = async (isRefresh = false) => {
    if (!selectedEnvironment?.id) return;
    if (!isRefresh) setLoading(true);
    try {
      const response = await getAgents(selectedEnvironment.id);
      setSshUser(response.sshUser);
      setAgents(response.agents);
      setBundledAgentVersion(response.bundledAgentVersion);
    } finally {
      if (!isRefresh) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    setTestResults({});
  }, [selectedEnvironment?.id]);

  // Auto-refresh every 30 seconds if enabled
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const interval = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(interval);
  }, [selectedEnvironment?.id, autoRefreshEnabled]);

  const handleTestAll = async () => {
    if (!selectedEnvironment?.id) return;
    setTestingAll(true);
    setTestResults({});
    try {
      const { results } = await testAllSSH(selectedEnvironment.id);
      const newResults: typeof testResults = {};
      results.forEach((r) => {
        newResults[r.serverId] = { success: r.success, durationMs: r.durationMs, error: r.error };
      });
      setTestResults(newResults);
      await fetchData();
    } finally {
      setTestingAll(false);
    }
  };

  const handleTestSingle = async (serverId: string) => {
    setTestingServer(serverId);
    try {
      const result = await testServerSSH(serverId);
      setTestResults((prev) => ({
        ...prev,
        [serverId]: { success: result.success, durationMs: result.durationMs, error: result.error },
      }));
      await fetchData();
    } finally {
      setTestingServer(null);
    }
  };

  const handleModeChange = async (serverId: string, mode: MetricsMode) => {
    setChangingMode(serverId);
    try {
      await updateServerMetricsMode(serverId, mode);
      await fetchData();
    } finally {
      setChangingMode(null);
    }
  };

  const handleRegenerateToken = async (serverId: string) => {
    const ok = await confirm({
      title: 'Regenerate agent token?',
      description: 'This will regenerate the agent token and redeploy the agent. Continue?',
      confirmText: 'Regenerate',
    });
    if (!ok) {
      return;
    }
    setRegenerating(serverId);
    try {
      await regenerateAgentToken(serverId);
      await fetchData();
      // Refresh events if this agent is expanded
      if (expandedAgent === serverId) {
        const { events } = await getAgentEvents(serverId);
        setAgentEvents(events);
      }
    } catch (e) {
      // Error is handled by API client
    } finally {
      setRegenerating(null);
    }
  };

  const handleRemoveAgent = async (serverId: string, serverName: string) => {
    const ok = await confirm({
      title: 'Remove monitoring agent?',
      description: `This will stop and remove the monitoring agent from ${serverName}. Continue?`,
      confirmText: 'Remove',
      destructive: true,
    });
    if (!ok) {
      return;
    }
    setRemoving(serverId);
    try {
      await removeAgent(serverId);
      await fetchData();
      // Close expanded row if this agent was expanded
      if (expandedAgent === serverId) {
        setExpandedAgent(null);
        setAgentEvents([]);
      }
    } catch (e) {
      // Error is handled by API client
    } finally {
      setRemoving(null);
    }
  };

  const handleUpdateAgent = async (serverId: string) => {
    setUpdating(serverId);
    try {
      await deployAgent(serverId);
      await fetchData();
      // Refresh events if this agent is expanded
      if (expandedAgent === serverId) {
        const { events } = await getAgentEvents(serverId);
        setAgentEvents(events);
      }
    } catch (e) {
      // Error is handled by API client
    } finally {
      setUpdating(null);
    }
  };

  const handleToggleExpand = async (serverId: string) => {
    if (expandedAgent === serverId) {
      setExpandedAgent(null);
      setAgentEvents([]);
    } else {
      setExpandedAgent(serverId);
      setLoadingEvents(true);
      try {
        const { events } = await getAgentEvents(serverId);
        setAgentEvents(events);
      } finally {
        setLoadingEvents(false);
      }
    }
  };

  const getEventTypeBadge = (eventType: string) => {
    const EVENT_BADGES: Record<string, { variant: StatusVariant; label: string }> = {
      deploy_started: { variant: 'info', label: 'Deploy Started' },
      deploy_success: { variant: 'success', label: 'Deploy Success' },
      deploy_failed: { variant: 'destructive', label: 'Deploy Failed' },
      token_regenerated: { variant: 'info', label: 'Token Regenerated' },
      status_change: { variant: 'warning', label: 'Status Change' },
    };
    const badge = EVENT_BADGES[eventType] ?? { variant: 'neutral' as StatusVariant, label: eventType };
    return <StatusBadge kind="severity" value={eventType} variant={badge.variant} label={badge.label} />;
  };

  const getStatusBadge = (status: string) => {
    const label = status === 'healthy' ? 'OK' : status === 'unhealthy' ? 'Failed' : 'Unknown';
    return <StatusBadge kind="health" value={status} label={label} />;
  };

  const getAgentStatusBadge = (status: AgentStatus) => {
    const AGENT_BADGES: Record<AgentStatus, { variant: StatusVariant; label: string; pulse?: boolean }> = {
      active: { variant: 'success', label: 'Active' },
      deploying: { variant: 'info', label: 'Deploying...', pulse: true },
      waiting: { variant: 'warning', label: 'Waiting' },
      stale: { variant: 'warning', label: 'Stale' },
      offline: { variant: 'destructive', label: 'Offline' },
      unknown: { variant: 'neutral', label: 'Unknown' },
    };
    const badge = AGENT_BADGES[status] ?? { variant: 'neutral' as StatusVariant, label: 'Unknown' };
    return (
      <StatusBadge
        kind="severity"
        value={status}
        variant={badge.variant}
        label={badge.label}
        className={cn(badge.pulse && 'animate-pulse')}
      />
    );
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Select an environment to view agents</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-muted-foreground">
          Manage SSH connections and monitoring agents
        </p>
        <div className="flex items-center gap-3">
          <Label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch
              checked={autoRefreshEnabled}
              onCheckedChange={setAutoRefreshEnabled}
              aria-label="Auto-refresh"
            />
            Auto: 30s
          </Label>
          <Button onClick={handleTestAll} disabled={testingAll}>
            {testingAll ? 'Testing...' : 'Test All'}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabType)} className="mb-6">
        <TabsList variant="line">
          <TabsTrigger value="ssh">SSH Connections</TabsTrigger>
          <TabsTrigger value="agents">Monitoring Agents</TabsTrigger>
        </TabsList>
      </Tabs>

      {loading ? (
        <Card className="p-4">
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </Card>
      ) : activeTab === 'ssh' ? (
        <>
          {/* SSH Config */}
          <Card className="mb-6 gap-0 p-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Environment SSH Config</h3>
            <div className="flex items-center gap-4">
              <div>
                <span className="text-muted-foreground text-sm">Username:</span>
                <span className="ml-2 text-foreground font-mono">{sshUser}</span>
              </div>
              <div>
                <span className="text-muted-foreground text-sm">SSH Key:</span>
                <span className="ml-2 text-muted-foreground">Configured</span>
              </div>
              <Button asChild variant="secondary" className="ml-auto">
                <Link to="/settings">Update</Link>
              </Button>
            </div>
          </Card>

          {/* Server Connections */}
          <Card className="gap-0 overflow-hidden p-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-4">Server Connections</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Server</TableHead>
                  <TableHead>Private IP</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Test</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <Link to={`/servers/${agent.id}`} className="text-foreground hover:text-primary">
                        {agent.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{agent.hostname}</TableCell>
                    <TableCell>
                      {testResults[agent.id] ? (
                        testResults[agent.id].success ? (
                          <StatusBadge
                            kind="health"
                            value="healthy"
                            label={`OK (${testResults[agent.id].durationMs}ms)`}
                          />
                        ) : (
                          <StatusBadge
                            kind="health"
                            value="unhealthy"
                            label="Failed"
                            title={testResults[agent.id].error}
                          />
                        )
                      ) : (
                        getStatusBadge(agent.sshStatus)
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {agent.lastCheckedAt
                        ? formatDistanceToNow(new Date(agent.lastCheckedAt), { addSuffix: true })
                        : 'Never'}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => handleTestSingle(agent.id)}
                        disabled={testingServer === agent.id}
                      >
                        {testingServer === agent.id ? 'Testing...' : 'Test'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      ) : (
        <>
          {/* Monitoring Agents */}
          <Card className="gap-0 overflow-hidden p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead>Metrics Mode</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Status Changed</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Update</TableHead>
                  <TableHead>Last Push</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <Fragment key={agent.id}>
                    <TableRow>
                      <TableCell>
                        {agent.metricsMode === 'agent' && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleToggleExpand(agent.id)}
                            title={expandedAgent === agent.id ? 'Collapse' : 'Show event history'}
                          >
                            <ChevronRight
                              className={cn(
                                'size-4 transition-transform',
                                expandedAgent === agent.id && 'rotate-90'
                              )}
                            />
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        <Link to={`/servers/${agent.id}`} className="text-foreground hover:text-primary">
                          {agent.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={agent.metricsMode}
                          onValueChange={(v) => handleModeChange(agent.id, v as MetricsMode)}
                          disabled={changingMode === agent.id}
                        >
                          <SelectTrigger size="sm" className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="disabled">Disabled</SelectItem>
                            <SelectItem value="ssh">SSH</SelectItem>
                            <SelectItem value="agent">Agent</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {agent.metricsMode === 'agent' ? (
                          getAgentStatusBadge(agent.agentStatus)
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {agent.metricsMode === 'agent' && agent.agentStatusChangedAt
                          ? formatDistanceToNow(new Date(agent.agentStatusChangedAt), { addSuffix: true })
                          : '--'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground font-mono">
                        {agent.metricsMode === 'agent' && agent.agentVersion
                          ? agent.agentVersion
                          : '--'}
                      </TableCell>
                      <TableCell>
                        {agent.metricsMode === 'agent' &&
                          agent.agentVersion &&
                          bundledAgentVersion !== 'unknown' &&
                          agent.agentVersion !== bundledAgentVersion ? (
                          <StatusBadge kind="severity" value="warning" variant="warning" label="Available" />
                        ) : agent.metricsMode === 'agent' && agent.agentVersion ? (
                          <span className="text-muted-foreground text-xs">Up to date</span>
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {agent.metricsMode === 'agent' && agent.lastAgentPushAt
                          ? formatDistanceToNow(new Date(agent.lastAgentPushAt), { addSuffix: true })
                          : '--'}
                      </TableCell>
                      <TableCell>
                        {agent.metricsMode === 'agent' && (
                          <div className="flex gap-2">
                            {agent.agentVersion &&
                              bundledAgentVersion !== 'unknown' &&
                              agent.agentVersion !== bundledAgentVersion && (
                              <Button
                                size="xs"
                                onClick={() => handleUpdateAgent(agent.id)}
                                disabled={updating === agent.id || regenerating === agent.id || removing === agent.id}
                                title="Update agent to latest version"
                              >
                                {updating === agent.id ? 'Updating...' : 'Update'}
                              </Button>
                            )}
                            <Button
                              variant="secondary"
                              size="xs"
                              onClick={() => handleRegenerateToken(agent.id)}
                              disabled={regenerating === agent.id || removing === agent.id || updating === agent.id}
                              title="Regenerate token and redeploy agent"
                            >
                              {regenerating === agent.id ? 'Regenerating...' : 'Regenerate Token'}
                            </Button>
                            <Button
                              variant="destructive"
                              size="xs"
                              onClick={() => handleRemoveAgent(agent.id, agent.name)}
                              disabled={removing === agent.id || regenerating === agent.id || updating === agent.id}
                              title="Stop and remove agent"
                            >
                              {removing === agent.id ? 'Removing...' : 'Remove'}
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                    {expandedAgent === agent.id && (
                      <TableRow className="bg-muted/50 hover:bg-muted/50">
                        <TableCell colSpan={9} className="p-4">
                          <div className="text-sm font-medium text-foreground mb-3">Event History</div>
                          {loadingEvents ? (
                            <div className="space-y-2">
                              {[1, 2, 3].map((i) => (
                                <Skeleton key={i} className="h-8 w-full" />
                              ))}
                            </div>
                          ) : agentEvents.length === 0 ? (
                            <div className="text-muted-foreground text-sm">No events recorded</div>
                          ) : (
                            <Table className="text-sm">
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Type</TableHead>
                                  <TableHead>Status</TableHead>
                                  <TableHead>Message</TableHead>
                                  <TableHead>Time</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {agentEvents.map((event) => (
                                  <TableRow key={event.id}>
                                    <TableCell>{getEventTypeBadge(event.eventType)}</TableCell>
                                    <TableCell className="text-muted-foreground">
                                      {event.status || '--'}
                                    </TableCell>
                                    <TableCell className={event.eventType === 'deploy_failed' ? 'text-destructive' : 'text-muted-foreground'}>
                                      {event.message || '--'}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                      {format(new Date(event.createdAt), 'MMM d, HH:mm:ss')}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
