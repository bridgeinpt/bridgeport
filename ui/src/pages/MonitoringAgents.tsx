import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getAgents,
  getAgentEvents,
  testAllSSH,
  testServerSSH,
  updateServerMetricsMode,
  regenerateAgentToken,
  type AgentInfo,
  type AgentEvent,
  type MetricsMode,
  type AgentStatus,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';

type TabType = 'ssh' | 'agents';

export default function MonitoringAgents() {
  const { selectedEnvironment } = useAppStore();
  const location = useLocation();
  const navigate = useNavigate();

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
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const activeTab = getTabFromHash();

  const setActiveTab = (tab: TabType) => {
    navigate({ hash: tab }, { replace: true });
  };

  const fetchData = async () => {
    if (!selectedEnvironment?.id) return;
    setLoading(true);
    try {
      const response = await getAgents(selectedEnvironment.id);
      setSshUser(response.sshUser);
      setAgents(response.agents);
      setBundledAgentVersion(response.bundledAgentVersion);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    setTestResults({});
  }, [selectedEnvironment?.id]);

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
    if (!confirm('This will regenerate the agent token and redeploy the agent. Continue?')) {
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
    switch (eventType) {
      case 'deploy_started':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400">Deploy Started</span>;
      case 'deploy_success':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400">Deploy Success</span>;
      case 'deploy_failed':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400">Deploy Failed</span>;
      case 'token_regenerated':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-purple-500/20 text-purple-400">Token Regenerated</span>;
      case 'status_change':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-500/20 text-yellow-400">Status Change</span>;
      default:
        return <span className="px-2 py-0.5 text-xs rounded-full bg-slate-500/20 text-slate-400">{eventType}</span>;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'healthy':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400">OK</span>;
      case 'unhealthy':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400">Failed</span>;
      default:
        return <span className="px-2 py-0.5 text-xs rounded-full bg-slate-500/20 text-slate-400">Unknown</span>;
    }
  };

  const getAgentStatusBadge = (status: AgentStatus) => {
    switch (status) {
      case 'active':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400">Active</span>;
      case 'deploying':
        return (
          <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400 animate-pulse">
            Deploying...
          </span>
        );
      case 'waiting':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-500/20 text-yellow-400">Waiting</span>;
      case 'stale':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-orange-500/20 text-orange-400">Stale</span>;
      case 'offline':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400">Offline</span>;
      default:
        return <span className="px-2 py-0.5 text-xs rounded-full bg-slate-500/20 text-slate-400">Unknown</span>;
    }
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <p className="text-slate-400">Select an environment to view agents</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Manage SSH connections and monitoring agents
        </p>
        <button
          onClick={handleTestAll}
          disabled={testingAll}
          className="btn btn-primary"
        >
          {testingAll ? 'Testing...' : 'Test All'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-700 mb-6">
        <button
          onClick={() => setActiveTab('ssh')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            activeTab === 'ssh'
              ? 'border-brand-600 text-white'
              : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          SSH Connections
        </button>
        <button
          onClick={() => setActiveTab('agents')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            activeTab === 'agents'
              ? 'border-brand-600 text-white'
              : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          Monitoring Agents
        </button>
      </div>

      {loading ? (
        <div className="card">
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 bg-slate-700 rounded" />
            ))}
          </div>
        </div>
      ) : activeTab === 'ssh' ? (
        <>
          {/* SSH Config */}
          <div className="card mb-6">
            <h3 className="text-sm font-medium text-slate-400 mb-2">Environment SSH Config</h3>
            <div className="flex items-center gap-4">
              <div>
                <span className="text-slate-500 text-sm">Username:</span>
                <span className="ml-2 text-white font-mono">{sshUser}</span>
              </div>
              <div>
                <span className="text-slate-500 text-sm">SSH Key:</span>
                <span className="ml-2 text-slate-400">Configured</span>
              </div>
              <Link to="/settings" className="btn btn-secondary ml-auto">
                Update
              </Link>
            </div>
          </div>

          {/* Server Connections */}
          <div className="card overflow-hidden">
            <h3 className="text-sm font-medium text-slate-400 mb-4">Server Connections</h3>
            <table className="w-full">
              <thead>
                <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                  <th className="pb-3 font-medium">Server</th>
                  <th className="pb-3 font-medium">Private IP</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Last Test</th>
                  <th className="pb-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {agents.map((agent) => (
                  <tr key={agent.id} className="text-slate-300">
                    <td className="py-3">
                      <Link to={`/servers/${agent.id}`} className="text-white hover:text-brand-400">
                        {agent.name}
                      </Link>
                    </td>
                    <td className="py-3 font-mono text-sm">{agent.hostname}</td>
                    <td className="py-3">
                      {testResults[agent.id] ? (
                        testResults[agent.id].success ? (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400">
                            OK ({testResults[agent.id].durationMs}ms)
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400" title={testResults[agent.id].error}>
                            Failed
                          </span>
                        )
                      ) : (
                        getStatusBadge(agent.sshStatus)
                      )}
                    </td>
                    <td className="py-3 text-sm text-slate-500">
                      {agent.lastCheckedAt
                        ? formatDistanceToNow(new Date(agent.lastCheckedAt), { addSuffix: true })
                        : 'Never'}
                    </td>
                    <td className="py-3">
                      <button
                        onClick={() => handleTestSingle(agent.id)}
                        disabled={testingServer === agent.id}
                        className="btn btn-secondary px-2 py-1 text-xs"
                      >
                        {testingServer === agent.id ? 'Testing...' : 'Test'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          {/* Monitoring Agents */}
          <div className="card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                  <th className="pb-3 font-medium w-8"></th>
                  <th className="pb-3 font-medium">Server</th>
                  <th className="pb-3 font-medium">Metrics Mode</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Status Changed</th>
                  <th className="pb-3 font-medium">Version</th>
                  <th className="pb-3 font-medium">Update</th>
                  <th className="pb-3 font-medium">Last Push</th>
                  <th className="pb-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <>
                    <tr key={agent.id} className="text-slate-300 border-b border-slate-700">
                      <td className="py-3">
                        {agent.metricsMode === 'agent' && (
                          <button
                            onClick={() => handleToggleExpand(agent.id)}
                            className="text-slate-400 hover:text-white p-1"
                            title={expandedAgent === agent.id ? 'Collapse' : 'Show event history'}
                          >
                            <svg
                              className={`w-4 h-4 transition-transform ${expandedAgent === agent.id ? 'rotate-90' : ''}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                        )}
                      </td>
                      <td className="py-3">
                        <Link to={`/servers/${agent.id}`} className="text-white hover:text-brand-400">
                          {agent.name}
                        </Link>
                      </td>
                      <td className="py-3">
                        <select
                          value={agent.metricsMode}
                          onChange={(e) => handleModeChange(agent.id, e.target.value as MetricsMode)}
                          disabled={changingMode === agent.id}
                          className="input py-1 px-2 w-28"
                        >
                          <option value="disabled">Disabled</option>
                          <option value="ssh">SSH</option>
                          <option value="agent">Agent</option>
                        </select>
                      </td>
                      <td className="py-3">
                        {agent.metricsMode === 'agent' ? (
                          getAgentStatusBadge(agent.agentStatus)
                        ) : (
                          <span className="text-slate-500">--</span>
                        )}
                      </td>
                      <td className="py-3 text-sm text-slate-500">
                        {agent.metricsMode === 'agent' && agent.agentStatusChangedAt
                          ? formatDistanceToNow(new Date(agent.agentStatusChangedAt), { addSuffix: true })
                          : '--'}
                      </td>
                      <td className="py-3 text-sm text-slate-500 font-mono">
                        {agent.metricsMode === 'agent' && agent.agentVersion
                          ? agent.agentVersion
                          : '--'}
                      </td>
                      <td className="py-3">
                        {agent.metricsMode === 'agent' &&
                          agent.agentVersion &&
                          bundledAgentVersion !== 'unknown' &&
                          agent.agentVersion !== bundledAgentVersion ? (
                          <span className="px-2 py-0.5 text-xs rounded bg-yellow-500/20 text-yellow-400">
                            Available
                          </span>
                        ) : agent.metricsMode === 'agent' && agent.agentVersion ? (
                          <span className="text-slate-500 text-xs">Up to date</span>
                        ) : (
                          <span className="text-slate-500">--</span>
                        )}
                      </td>
                      <td className="py-3 text-sm text-slate-500">
                        {agent.metricsMode === 'agent' && agent.lastAgentPushAt
                          ? formatDistanceToNow(new Date(agent.lastAgentPushAt), { addSuffix: true })
                          : '--'}
                      </td>
                      <td className="py-3">
                        {agent.metricsMode === 'agent' && (
                          <button
                            onClick={() => handleRegenerateToken(agent.id)}
                            disabled={regenerating === agent.id}
                            className="btn btn-secondary px-2 py-1 text-xs"
                            title="Regenerate token and redeploy agent"
                          >
                            {regenerating === agent.id ? 'Regenerating...' : 'Regenerate Token'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedAgent === agent.id && (
                      <tr key={`${agent.id}-events`} className="bg-slate-800/50">
                        <td colSpan={9} className="p-4">
                          <div className="text-sm font-medium text-slate-300 mb-3">Event History</div>
                          {loadingEvents ? (
                            <div className="animate-pulse space-y-2">
                              {[1, 2, 3].map((i) => (
                                <div key={i} className="h-8 bg-slate-700 rounded" />
                              ))}
                            </div>
                          ) : agentEvents.length === 0 ? (
                            <div className="text-slate-500 text-sm">No events recorded</div>
                          ) : (
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="text-left text-slate-500 border-b border-slate-700">
                                  <th className="pb-2 font-medium">Type</th>
                                  <th className="pb-2 font-medium">Status</th>
                                  <th className="pb-2 font-medium">Message</th>
                                  <th className="pb-2 font-medium">Time</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-700/50">
                                {agentEvents.map((event) => (
                                  <tr key={event.id}>
                                    <td className="py-2">{getEventTypeBadge(event.eventType)}</td>
                                    <td className="py-2 text-slate-400">
                                      {event.status || '--'}
                                    </td>
                                    <td className={`py-2 ${event.eventType === 'deploy_failed' ? 'text-red-400' : 'text-slate-400'}`}>
                                      {event.message || '--'}
                                    </td>
                                    <td className="py-2 text-slate-500">
                                      {format(new Date(event.createdAt), 'MMM d, HH:mm:ss')}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>

          </div>

        </>
      )}
    </div>
  );
}
