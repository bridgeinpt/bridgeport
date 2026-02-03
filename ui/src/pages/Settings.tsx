import { useEffect, useState } from 'react';
import { useAppStore, isAdmin } from '../lib/store';
import { useAuthStore } from '../lib/store';
import {
  getEnvironmentSettings,
  updateEnvironmentSettings,
  getSpacesConfig,
  updateSpacesConfig,
  deleteSpacesConfig,
  testSpacesConfig,
  listServers,
  listDatabases,
  getSchedulerConfig,
  updateSchedulerConfig,
  type Server,
  type Database,
  type SpacesConfig,
  type SchedulerConfig,
} from '../lib/api';
import { useToast } from '../components/Toast';

interface EnvironmentSettings {
  allowSecretReveal: boolean;
  allowBackupDownload: boolean;
}

interface ModuleStatus {
  monitoring: {
    enabled: boolean;
    serversWithSsh: number;
    serversWithAgent: number;
    totalServers: number;
  };
  databases: {
    enabled: boolean;
    count: number;
    withBackups: number;
  };
}

export default function Settings() {
  const { selectedEnvironment } = useAppStore();
  const { user } = useAuthStore();
  const toast = useToast();
  const [settings, setSettings] = useState<EnvironmentSettings | null>(null);
  const [moduleStatus, setModuleStatus] = useState<ModuleStatus | null>(null);
  const [spacesConfig, setSpacesConfig] = useState<SpacesConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingSpaces, setEditingSpaces] = useState(false);
  const [testingSpaces, setTestingSpaces] = useState(false);
  const [spacesTestResult, setSpacesTestResult] = useState<{
    success: boolean;
    message: string;
    buckets?: string[];
  } | null>(null);
  const [spacesForm, setSpacesForm] = useState({
    spacesAccessKey: '',
    spacesSecretKey: '',
    spacesRegion: 'fra1',
  });
  const [schedulerConfig, setSchedulerConfig] = useState<SchedulerConfig | null>(null);
  const [monitoringExpanded, setMonitoringExpanded] = useState(false);
  const [savingScheduler, setSavingScheduler] = useState(false);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      loadData();
    }
  }, [selectedEnvironment?.id]);

  const loadData = async () => {
    if (!selectedEnvironment?.id) return;
    setLoading(true);
    try {
      const [settingsRes, serversRes, databasesRes, spacesRes, schedulerRes] = await Promise.all([
        getEnvironmentSettings(selectedEnvironment.id),
        listServers(selectedEnvironment.id),
        listDatabases(selectedEnvironment.id),
        getSpacesConfig(selectedEnvironment.id),
        getSchedulerConfig(selectedEnvironment.id),
      ]);

      setSettings(settingsRes.settings);
      setSpacesConfig(spacesRes);
      setSchedulerConfig(schedulerRes.config);

      // Calculate module status
      const servers = serversRes.servers as Array<Server & { metricsMode?: string }>;
      const databases = databasesRes.databases;

      setModuleStatus({
        monitoring: {
          enabled: servers.some((s: Server & { metricsMode?: string }) => s.metricsMode !== 'disabled'),
          serversWithSsh: servers.filter((s: Server & { metricsMode?: string }) => s.metricsMode === 'ssh').length,
          serversWithAgent: servers.filter((s: Server & { metricsMode?: string }) => s.metricsMode === 'agent').length,
          totalServers: servers.length,
        },
        databases: {
          enabled: databases.length > 0,
          count: databases.length,
          withBackups: databases.filter((d: Database) => d._count && d._count.backups > 0).length,
        },
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSettingChange = async (key: keyof EnvironmentSettings, value: boolean) => {
    if (!selectedEnvironment?.id || !isAdmin(user)) return;
    setSaving(true);
    try {
      const result = await updateEnvironmentSettings(selectedEnvironment.id, { [key]: value });
      setSettings(result.settings);
      toast.success('Settings updated');
      // Reload page data to reflect changes
      window.location.reload();
    } catch (error) {
      toast.error('Failed to update settings');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSpaces = async () => {
    if (!selectedEnvironment?.id || !isAdmin(user)) return;
    if (!spacesForm.spacesAccessKey || !spacesForm.spacesSecretKey || !spacesForm.spacesRegion) {
      toast.error('Please fill in all required fields');
      return;
    }
    setSaving(true);
    try {
      await updateSpacesConfig(selectedEnvironment.id, spacesForm);
      const spacesRes = await getSpacesConfig(selectedEnvironment.id);
      setSpacesConfig(spacesRes);
      setEditingSpaces(false);
      setSpacesForm({ spacesAccessKey: '', spacesSecretKey: '', spacesRegion: 'fra1' });
      toast.success('Spaces configuration saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save Spaces configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSpaces = async () => {
    if (!selectedEnvironment?.id || !isAdmin(user)) return;
    if (!confirm('Remove Spaces configuration? Existing backups stored in Spaces will not be deleted.')) return;
    setSaving(true);
    try {
      await deleteSpacesConfig(selectedEnvironment.id);
      setSpacesConfig({ configured: false, spacesAccessKey: null, spacesRegion: null, spacesEndpoint: null });
      toast.success('Spaces configuration removed');
    } catch (error) {
      toast.error('Failed to remove Spaces configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleTestSpaces = async () => {
    if (!selectedEnvironment?.id) return;
    setTestingSpaces(true);
    setSpacesTestResult(null);
    try {
      const result = await testSpacesConfig(selectedEnvironment.id);
      setSpacesTestResult(result);
      if (result.success) {
        toast.success('Connection successful');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection test failed';
      setSpacesTestResult({ success: false, message });
      toast.error(message);
    } finally {
      setTestingSpaces(false);
    }
  };

  const handleSchedulerConfigChange = async (key: keyof SchedulerConfig, value: number) => {
    if (!selectedEnvironment?.id || !isAdmin(user) || !schedulerConfig) return;
    setSavingScheduler(true);
    try {
      const result = await updateSchedulerConfig(selectedEnvironment.id, { [key]: value });
      setSchedulerConfig(result.config);
      toast.success('Scheduler config updated');
    } catch (error) {
      toast.error('Failed to update scheduler config');
    } finally {
      setSavingScheduler(false);
    }
  };

  const handleResetSchedulerConfig = async () => {
    if (!selectedEnvironment?.id || !isAdmin(user)) return;
    if (!confirm('Reset all scheduler settings to defaults?')) return;
    setSavingScheduler(true);
    try {
      const result = await updateSchedulerConfig(selectedEnvironment.id, {
        serverHealthIntervalMs: 60000,
        serviceHealthIntervalMs: 60000,
        discoveryIntervalMs: 300000,
        metricsIntervalMs: 300000,
        updateCheckIntervalMs: 1800000,
        backupCheckIntervalMs: 60000,
        metricsRetentionDays: 7,
        healthLogRetentionDays: 30,
        bounceThreshold: 3,
        bounceCooldownMs: 900000,
      });
      setSchedulerConfig(result.config);
      toast.success('Scheduler config reset to defaults');
    } catch (error) {
      toast.error('Failed to reset scheduler config');
    } finally {
      setSavingScheduler(false);
    }
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-8">
        <div className="card text-center py-12">
          <p className="text-slate-400">Please select an environment</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-8"></div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-5">
        <p className="text-slate-400">
          Configure settings for {selectedEnvironment.name}
        </p>
      </div>

      {/* Module Status */}
      <div className="card mb-6">
        <h3 className="text-lg font-semibold text-white mb-4">Module Status</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Monitoring Module */}
          <div className="p-4 bg-slate-800 rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <span className="font-medium text-white">Monitoring</span>
              </div>
              <span className={`px-2 py-1 rounded text-xs font-medium ${
                moduleStatus?.monitoring.enabled
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-slate-700 text-slate-400'
              }`}>
                {moduleStatus?.monitoring.enabled ? 'Active' : 'Inactive'}
              </span>
            </div>
            {moduleStatus && (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between text-slate-400">
                  <span>Servers with SSH monitoring:</span>
                  <span className="text-white">{moduleStatus.monitoring.serversWithSsh}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Servers with Agent monitoring:</span>
                  <span className="text-white">{moduleStatus.monitoring.serversWithAgent}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Total servers:</span>
                  <span className="text-white">{moduleStatus.monitoring.totalServers}</span>
                </div>
              </div>
            )}
          </div>

          {/* Databases Module */}
          <div className="p-4 bg-slate-800 rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                </svg>
                <span className="font-medium text-white">Databases</span>
              </div>
              <span className={`px-2 py-1 rounded text-xs font-medium ${
                moduleStatus?.databases.enabled
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-slate-700 text-slate-400'
              }`}>
                {moduleStatus?.databases.enabled ? 'Active' : 'Inactive'}
              </span>
            </div>
            {moduleStatus && (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between text-slate-400">
                  <span>Registered databases:</span>
                  <span className="text-white">{moduleStatus.databases.count}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>With backups:</span>
                  <span className="text-white">{moduleStatus.databases.withBackups}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Security Settings */}
      <div className="card mb-6">
        <h3 className="text-lg font-semibold text-white mb-4">Security Settings</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-slate-800 rounded-lg">
            <div>
              <p className="font-medium text-white">Allow Secret Reveal</p>
              <p className="text-sm text-slate-400">
                Allow users to reveal secret values in this environment. Disable for production.
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings?.allowSecretReveal ?? true}
                onChange={(e) => handleSettingChange('allowSecretReveal', e.target.checked)}
                disabled={saving || !isAdmin(user)}
                className="sr-only peer"
              />
              <div className={`w-11 h-6 bg-slate-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600 ${
                !isAdmin(user) ? 'opacity-50 cursor-not-allowed' : ''
              }`}></div>
            </label>
          </div>

          <div className="flex items-center justify-between p-4 bg-slate-800 rounded-lg">
            <div>
              <p className="font-medium text-white">Allow Backup Downloads</p>
              <p className="text-sm text-slate-400">
                Allow users to download database backups. Enable with caution for sensitive data.
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings?.allowBackupDownload ?? false}
                onChange={(e) => handleSettingChange('allowBackupDownload', e.target.checked)}
                disabled={saving || !isAdmin(user)}
                className="sr-only peer"
              />
              <div className={`w-11 h-6 bg-slate-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600 ${
                !isAdmin(user) ? 'opacity-50 cursor-not-allowed' : ''
              }`}></div>
            </label>
          </div>

          {!isAdmin(user) && (
            <p className="text-sm text-slate-500">
              Only administrators can modify environment settings.
            </p>
          )}
        </div>
      </div>

      {/* Spaces Configuration */}
      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-white">DO Spaces Configuration</h3>
            <p className="text-sm text-slate-400">Configure DigitalOcean Spaces for database backups</p>
          </div>
          {spacesConfig?.configured && !editingSpaces && isAdmin(user) && (
            <button
              onClick={handleDeleteSpaces}
              disabled={saving}
              className="btn btn-ghost text-red-400 hover:text-red-300 text-sm"
            >
              Remove
            </button>
          )}
        </div>

        {editingSpaces ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Access Key</label>
                <input
                  type="text"
                  value={spacesForm.spacesAccessKey}
                  onChange={(e) => setSpacesForm({ ...spacesForm, spacesAccessKey: e.target.value })}
                  placeholder="DO00..."
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Secret Key</label>
                <input
                  type="password"
                  value={spacesForm.spacesSecretKey}
                  onChange={(e) => setSpacesForm({ ...spacesForm, spacesSecretKey: e.target.value })}
                  placeholder="••••••••"
                  className="input"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Region</label>
              <select
                value={spacesForm.spacesRegion}
                onChange={(e) => setSpacesForm({ ...spacesForm, spacesRegion: e.target.value })}
                className="input"
              >
                <option value="nyc3">NYC3 (New York)</option>
                <option value="sfo3">SFO3 (San Francisco)</option>
                <option value="ams3">AMS3 (Amsterdam)</option>
                <option value="sgp1">SGP1 (Singapore)</option>
                <option value="fra1">FRA1 (Frankfurt)</option>
                <option value="syd1">SYD1 (Sydney)</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button onClick={handleSaveSpaces} disabled={saving} className="btn btn-primary">
                {saving ? 'Saving...' : 'Save Configuration'}
              </button>
              <button
                onClick={() => {
                  setEditingSpaces(false);
                  setSpacesForm({ spacesAccessKey: '', spacesSecretKey: '', spacesRegion: 'fra1' });
                }}
                className="btn btn-ghost"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : spacesConfig?.configured ? (
          <div className="p-4 bg-slate-800 rounded-lg">
            <div className="flex items-center gap-2 mb-3">
              <span className="px-2 py-1 rounded text-xs font-medium bg-green-500/20 text-green-400">
                Configured
              </span>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-slate-400">
                <span>Access Key:</span>
                <span className="text-white font-mono">{spacesConfig.spacesAccessKey}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Region:</span>
                <span className="text-white">{spacesConfig.spacesRegion}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Endpoint:</span>
                <span className="text-white font-mono text-xs">{spacesConfig.spacesEndpoint}</span>
              </div>
            </div>

            {/* Test Result */}
            {spacesTestResult && (
              <div className={`mt-4 p-3 rounded-lg ${
                spacesTestResult.success
                  ? 'bg-green-500/10 border border-green-500/30'
                  : 'bg-red-500/10 border border-red-500/30'
              }`}>
                <div className="flex items-center gap-2 mb-1">
                  {spacesTestResult.success ? (
                    <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                  <span className={spacesTestResult.success ? 'text-green-400' : 'text-red-400'}>
                    {spacesTestResult.message}
                  </span>
                </div>
                {spacesTestResult.success && spacesTestResult.buckets && spacesTestResult.buckets.length > 0 && (
                  <div className="mt-2 text-sm">
                    <span className="text-slate-400">Available buckets:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {spacesTestResult.buckets.map((bucket) => (
                        <span key={bucket} className="px-2 py-0.5 bg-slate-700 rounded text-xs text-white font-mono">
                          {bucket}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2 mt-4">
              <button
                onClick={handleTestSpaces}
                disabled={testingSpaces}
                className="btn btn-secondary text-sm"
              >
                {testingSpaces ? 'Testing...' : 'Test Connection'}
              </button>
              {isAdmin(user) && (
                <button
                  onClick={() => {
                    setSpacesForm({
                      spacesAccessKey: spacesConfig.spacesAccessKey || '',
                      spacesSecretKey: '',
                      spacesRegion: spacesConfig.spacesRegion || 'fra1',
                    });
                    setSpacesTestResult(null);
                    setEditingSpaces(true);
                  }}
                  className="btn btn-ghost text-sm"
                >
                  Update
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="p-4 bg-slate-800 rounded-lg text-center">
            <p className="text-slate-400 mb-4">
              Spaces is not configured. Configure it to enable cloud backups for databases.
            </p>
            {isAdmin(user) && (
              <button onClick={() => setEditingSpaces(true)} className="btn btn-primary">
                Configure Spaces
              </button>
            )}
          </div>
        )}
      </div>

      {/* Monitoring Settings */}
      <div className="card mb-6">
        <button
          onClick={() => setMonitoringExpanded(!monitoringExpanded)}
          className="w-full flex items-center justify-between"
        >
          <h3 className="text-lg font-semibold text-white">Monitoring Settings</h3>
          <svg
            className={`w-5 h-5 text-slate-400 transition-transform ${monitoringExpanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {monitoringExpanded && schedulerConfig && (
          <div className="mt-6 space-y-6">
            {/* Health Check Intervals */}
            <div>
              <h4 className="text-sm font-medium text-slate-300 mb-3">Health Check Intervals</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Server Health (SSH)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={schedulerConfig.serverHealthIntervalMs / 1000}
                      onChange={(e) => handleSchedulerConfigChange('serverHealthIntervalMs', parseInt(e.target.value) * 1000)}
                      min={10}
                      max={3600}
                      disabled={savingScheduler || !isAdmin(user)}
                      className="input w-24"
                    />
                    <span className="text-slate-500 text-sm">sec</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Service Health</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={schedulerConfig.serviceHealthIntervalMs / 1000}
                      onChange={(e) => handleSchedulerConfigChange('serviceHealthIntervalMs', parseInt(e.target.value) * 1000)}
                      min={10}
                      max={3600}
                      disabled={savingScheduler || !isAdmin(user)}
                      className="input w-24"
                    />
                    <span className="text-slate-500 text-sm">sec</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Container Discovery</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={schedulerConfig.discoveryIntervalMs / 1000}
                      onChange={(e) => handleSchedulerConfigChange('discoveryIntervalMs', parseInt(e.target.value) * 1000)}
                      min={60}
                      max={86400}
                      disabled={savingScheduler || !isAdmin(user)}
                      className="input w-24"
                    />
                    <span className="text-slate-500 text-sm">sec</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Metrics Collection */}
            <div>
              <h4 className="text-sm font-medium text-slate-300 mb-3">Metrics Collection</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Collection Interval</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={schedulerConfig.metricsIntervalMs / 1000}
                      onChange={(e) => handleSchedulerConfigChange('metricsIntervalMs', parseInt(e.target.value) * 1000)}
                      min={60}
                      max={3600}
                      disabled={savingScheduler || !isAdmin(user)}
                      className="input w-24"
                    />
                    <span className="text-slate-500 text-sm">sec</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Metrics Retention</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={schedulerConfig.metricsRetentionDays}
                      onChange={(e) => handleSchedulerConfigChange('metricsRetentionDays', parseInt(e.target.value))}
                      min={1}
                      max={365}
                      disabled={savingScheduler || !isAdmin(user)}
                      className="input w-24"
                    />
                    <span className="text-slate-500 text-sm">days</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Health Log Retention</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={schedulerConfig.healthLogRetentionDays}
                      onChange={(e) => handleSchedulerConfigChange('healthLogRetentionDays', parseInt(e.target.value))}
                      min={1}
                      max={365}
                      disabled={savingScheduler || !isAdmin(user)}
                      className="input w-24"
                    />
                    <span className="text-slate-500 text-sm">days</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Other Schedules */}
            <div>
              <h4 className="text-sm font-medium text-slate-300 mb-3">Other Schedules</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Registry Update Check</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={schedulerConfig.updateCheckIntervalMs / 1000}
                      onChange={(e) => handleSchedulerConfigChange('updateCheckIntervalMs', parseInt(e.target.value) * 1000)}
                      min={60}
                      max={86400}
                      disabled={savingScheduler || !isAdmin(user)}
                      className="input w-24"
                    />
                    <span className="text-slate-500 text-sm">sec</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Backup Check</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={schedulerConfig.backupCheckIntervalMs / 1000}
                      onChange={(e) => handleSchedulerConfigChange('backupCheckIntervalMs', parseInt(e.target.value) * 1000)}
                      min={10}
                      max={3600}
                      disabled={savingScheduler || !isAdmin(user)}
                      className="input w-24"
                    />
                    <span className="text-slate-500 text-sm">sec</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Alert Configuration */}
            <div>
              <h4 className="text-sm font-medium text-slate-300 mb-3">Alert Configuration</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Failure Threshold</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={schedulerConfig.bounceThreshold}
                      onChange={(e) => handleSchedulerConfigChange('bounceThreshold', parseInt(e.target.value))}
                      min={1}
                      max={10}
                      disabled={savingScheduler || !isAdmin(user)}
                      className="input w-24"
                    />
                    <span className="text-slate-500 text-sm">failures</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Cooldown</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={schedulerConfig.bounceCooldownMs / 1000}
                      onChange={(e) => handleSchedulerConfigChange('bounceCooldownMs', parseInt(e.target.value) * 1000)}
                      min={60}
                      max={86400}
                      disabled={savingScheduler || !isAdmin(user)}
                      className="input w-24"
                    />
                    <span className="text-slate-500 text-sm">sec</span>
                  </div>
                </div>
              </div>
            </div>

            {isAdmin(user) && (
              <div className="pt-4 border-t border-slate-700">
                <button
                  onClick={handleResetSchedulerConfig}
                  disabled={savingScheduler}
                  className="btn btn-ghost text-sm"
                >
                  Reset to Defaults
                </button>
              </div>
            )}

            {!isAdmin(user) && (
              <p className="text-sm text-slate-500 pt-2">
                Only administrators can modify scheduler settings.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Environment Info */}
      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-4">Environment Info</h3>
        <dl className="space-y-3">
          <div className="flex justify-between">
            <dt className="text-slate-400">Name</dt>
            <dd className="text-white font-medium">{selectedEnvironment.name}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-400">Servers</dt>
            <dd className="text-white">{selectedEnvironment._count?.servers ?? 0}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-400">Secrets</dt>
            <dd className="text-white">{selectedEnvironment._count?.secrets ?? 0}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-400">ID</dt>
            <dd className="text-slate-400 font-mono text-sm">{selectedEnvironment.id}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
