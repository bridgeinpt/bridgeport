import { useEffect, useState } from 'react';
import { useAuthStore, isAdmin } from '../../lib/store';
import {
  getGlobalSpacesConfig,
  updateGlobalSpacesConfig,
  deleteGlobalSpacesConfig,
  testGlobalSpacesConfig,
  getSpacesEnvironments,
  setSpacesEnvironmentEnabled,
  type GlobalSpacesConfig,
  type SpacesEnvironmentStatus,
} from '../../lib/api';
import { useToast } from '../../components/Toast';

export default function GlobalSpaces() {
  const { user } = useAuthStore();
  const toast = useToast();
  const [config, setConfig] = useState<GlobalSpacesConfig | null>(null);
  const [configured, setConfigured] = useState(false);
  const [environments, setEnvironments] = useState<SpacesEnvironmentStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; buckets?: string[] } | null>(null);

  const [form, setForm] = useState({
    accessKey: '',
    secretKey: '',
    region: 'fra1',
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [configRes, envsRes] = await Promise.all([
        getGlobalSpacesConfig(),
        getSpacesEnvironments(),
      ]);
      setConfigured(configRes.configured);
      setConfig(configRes.config);
      setEnvironments(envsRes.environments);
    } catch (error) {
      toast.error('Failed to load Spaces configuration');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!form.accessKey || !form.secretKey || !form.region) {
      toast.error('Please fill in all required fields');
      return;
    }
    setSaving(true);
    try {
      await updateGlobalSpacesConfig(form);
      toast.success('Spaces configuration saved');
      setEditing(false);
      setForm({ accessKey: '', secretKey: '', region: 'fra1' });
      loadData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Remove Spaces configuration? This will disable cloud backups for all environments.')) return;
    setSaving(true);
    try {
      await deleteGlobalSpacesConfig();
      toast.success('Spaces configuration removed');
      setConfig(null);
      setConfigured(false);
      loadData();
    } catch (error) {
      toast.error('Failed to remove configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testGlobalSpacesConfig();
      setTestResult(result);
      if (result.success) {
        toast.success('Connection successful');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection test failed';
      setTestResult({ success: false, message });
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  const handleToggleEnvironment = async (envId: string, enabled: boolean) => {
    try {
      await setSpacesEnvironmentEnabled(envId, enabled);
      setEnvironments((prev) =>
        prev.map((env) => (env.id === envId ? { ...env, spacesEnabled: enabled } : env))
      );
      toast.success(`Spaces ${enabled ? 'enabled' : 'disabled'} for environment`);
    } catch (error) {
      toast.error('Failed to update environment');
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-6"></div>
          <div className="h-48 bg-slate-800 rounded-xl"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Global Spaces Configuration</h1>
        <p className="text-slate-400 text-sm mt-1">
          Configure DigitalOcean Spaces for database backups across all environments
        </p>
      </div>

      {/* Configuration Card */}
      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">Connection Settings</h3>
          {configured && !editing && isAdmin(user) && (
            <button onClick={handleDelete} disabled={saving} className="btn btn-ghost text-red-400 hover:text-red-300 text-sm">
              Remove
            </button>
          )}
        </div>

        {editing ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Access Key</label>
                <input
                  type="text"
                  value={form.accessKey}
                  onChange={(e) => setForm({ ...form, accessKey: e.target.value })}
                  placeholder="DO00..."
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Secret Key</label>
                <input
                  type="password"
                  value={form.secretKey}
                  onChange={(e) => setForm({ ...form, secretKey: e.target.value })}
                  placeholder="Enter secret key"
                  className="input"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Region</label>
              <select
                value={form.region}
                onChange={(e) => setForm({ ...form, region: e.target.value })}
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
              <button onClick={handleSave} disabled={saving} className="btn btn-primary">
                {saving ? 'Saving...' : 'Save Configuration'}
              </button>
              <button onClick={() => { setEditing(false); setForm({ accessKey: '', secretKey: '', region: 'fra1' }); }} className="btn btn-ghost">
                Cancel
              </button>
            </div>
          </div>
        ) : configured && config ? (
          <div className="p-4 bg-slate-800 rounded-lg">
            <div className="flex items-center gap-2 mb-3">
              <span className="px-2 py-1 rounded text-xs font-medium bg-green-500/20 text-green-400">
                Configured
              </span>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-slate-400">
                <span>Access Key:</span>
                <span className="text-white font-mono">{config.accessKey}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Region:</span>
                <span className="text-white">{config.region}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Endpoint:</span>
                <span className="text-white font-mono text-xs">{config.endpoint}</span>
              </div>
            </div>

            {testResult && (
              <div className={`mt-4 p-3 rounded-lg ${
                testResult.success
                  ? 'bg-green-500/10 border border-green-500/30'
                  : 'bg-red-500/10 border border-red-500/30'
              }`}>
                <div className="flex items-center gap-2 mb-1">
                  {testResult.success ? (
                    <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                  <span className={testResult.success ? 'text-green-400' : 'text-red-400'}>
                    {testResult.message}
                  </span>
                </div>
                {testResult.success && testResult.buckets && testResult.buckets.length > 0 && (
                  <div className="mt-2 text-sm">
                    <span className="text-slate-400">Available buckets:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {testResult.buckets.map((bucket) => (
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
              <button onClick={handleTest} disabled={testing} className="btn btn-secondary text-sm">
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              {isAdmin(user) && (
                <button
                  onClick={() => {
                    setForm({ accessKey: config.accessKey, secretKey: '', region: config.region });
                    setTestResult(null);
                    setEditing(true);
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
              <button onClick={() => setEditing(true)} className="btn btn-primary">
                Configure Spaces
              </button>
            )}
          </div>
        )}
      </div>

      {/* Environments Card */}
      {configured && (
        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Environment Access</h3>
          <p className="text-slate-400 text-sm mb-4">
            Enable or disable Spaces access for each environment
          </p>
          <div className="space-y-2">
            {environments.map((env) => (
              <div key={env.id} className="flex items-center justify-between p-3 bg-slate-800 rounded-lg">
                <span className="text-white font-medium">{env.name}</span>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={env.spacesEnabled}
                    onChange={(e) => handleToggleEnvironment(env.id, e.target.checked)}
                    disabled={!isAdmin(user)}
                    className="sr-only peer"
                  />
                  <div className={`w-11 h-6 bg-slate-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600 ${
                    !isAdmin(user) ? 'opacity-50 cursor-not-allowed' : ''
                  }`}></div>
                </label>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
