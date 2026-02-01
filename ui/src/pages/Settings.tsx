import { useEffect, useState } from 'react';
import { useAppStore, isAdmin } from '../lib/store';
import { useAuthStore } from '../lib/store';
import {
  getEnvironmentSettings,
  updateEnvironmentSettings,
  listServers,
  listDatabases,
  type Server,
  type Database,
} from '../lib/api';
import { useToast } from '../components/Toast';

interface EnvironmentSettings {
  allowSecretReveal: boolean;
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      loadData();
    }
  }, [selectedEnvironment?.id]);

  const loadData = async () => {
    if (!selectedEnvironment?.id) return;
    setLoading(true);
    try {
      const [settingsRes, serversRes, databasesRes] = await Promise.all([
        getEnvironmentSettings(selectedEnvironment.id),
        listServers(selectedEnvironment.id),
        listDatabases(selectedEnvironment.id),
      ]);

      setSettings(settingsRes.settings);

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
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Environment Settings</h1>
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

          {!isAdmin(user) && (
            <p className="text-sm text-slate-500">
              Only administrators can modify environment settings.
            </p>
          )}
        </div>
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
