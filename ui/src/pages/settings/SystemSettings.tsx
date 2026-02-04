import { useState, useEffect } from 'react';
import { getSystemSettings, updateSystemSettings, resetSystemSettings } from '../../lib/api';

interface FormData {
  sshCommandTimeoutSec: number;
  sshReadyTimeoutSec: number;
  webhookMaxRetries: number;
  webhookTimeoutSec: number;
  webhookRetryDelaysSec: string;
  pgDumpTimeoutSec: number;
  maxUploadSizeMb: number;
  activeUserWindowMin: number;
  registryMaxTags: number;
  defaultLogLines: number;
  agentCallbackUrl: string;
  agentStaleThresholdSec: number;
  agentOfflineThresholdSec: number;
  doRegistryToken: string;
  auditLogRetentionDays: number;
}

interface Defaults {
  sshCommandTimeoutMs: number;
  sshReadyTimeoutMs: number;
  webhookMaxRetries: number;
  webhookTimeoutMs: number;
  webhookRetryDelaysMs: string;
  pgDumpTimeoutMs: number;
  maxUploadSizeMb: number;
  activeUserWindowMin: number;
  registryMaxTags: number;
  defaultLogLines: number;
  agentStaleThresholdMs: number;
  agentOfflineThresholdMs: number;
  auditLogRetentionDays: number;
}

function msToSec(ms: number): number {
  return Math.round(ms / 1000);
}

function secToMs(sec: number): number {
  return sec * 1000;
}

function parseDelaysMs(delaysJson: string): string {
  try {
    const delays = JSON.parse(delaysJson) as number[];
    return delays.map(d => Math.round(d / 1000)).join(', ');
  } catch {
    return '1, 5, 15';
  }
}

function formatDelaysMs(delaysSec: string): string {
  const delays = delaysSec.split(',').map(s => {
    const num = parseInt(s.trim(), 10);
    return isNaN(num) ? 1000 : num * 1000;
  });
  return JSON.stringify(delays);
}

// Collapsible section component
function SettingsSection({
  title,
  icon,
  children,
  defaultExpanded = false,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-5 hover:bg-slate-800/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="text-slate-400">{icon}</div>
          <h2 className="text-lg font-semibold text-white">{title}</h2>
        </div>
        <svg
          className={`w-5 h-5 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && <div className="px-5 pb-5 pt-0">{children}</div>}
    </section>
  );
}

// Icons
function SSHIcon({ className }: { className?: string }) {
  return (
    <svg className={className || "w-5 h-5"} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

function WebhookIcon({ className }: { className?: string }) {
  return (
    <svg className={className || "w-5 h-5"} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
    </svg>
  );
}

function RegistryIcon({ className }: { className?: string }) {
  return (
    <svg className={className || "w-5 h-5"} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

function AgentIcon({ className }: { className?: string }) {
  return (
    <svg className={className || "w-5 h-5"} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  );
}

function DatabaseIcon({ className }: { className?: string }) {
  return (
    <svg className={className || "w-5 h-5"} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  );
}

function LimitsIcon({ className }: { className?: string }) {
  return (
    <svg className={className || "w-5 h-5"} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
    </svg>
  );
}

function RetentionIcon({ className }: { className?: string }) {
  return (
    <svg className={className || "w-5 h-5"} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

export default function SystemSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [formData, setFormData] = useState<FormData>({
    sshCommandTimeoutSec: 60,
    sshReadyTimeoutSec: 10,
    webhookMaxRetries: 3,
    webhookTimeoutSec: 30,
    webhookRetryDelaysSec: '1, 5, 15',
    pgDumpTimeoutSec: 300,
    maxUploadSizeMb: 50,
    activeUserWindowMin: 15,
    registryMaxTags: 50,
    defaultLogLines: 50,
    agentCallbackUrl: '',
    agentStaleThresholdSec: 180,
    agentOfflineThresholdSec: 300,
    doRegistryToken: '',
    auditLogRetentionDays: 90,
  });
  const [doRegistryTokenSet, setDoRegistryTokenSet] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);
      const { settings, defaults } = await getSystemSettings();
      setDefaults(defaults);
      setFormData({
        sshCommandTimeoutSec: msToSec(settings.sshCommandTimeoutMs),
        sshReadyTimeoutSec: msToSec(settings.sshReadyTimeoutMs),
        webhookMaxRetries: settings.webhookMaxRetries,
        webhookTimeoutSec: msToSec(settings.webhookTimeoutMs),
        webhookRetryDelaysSec: parseDelaysMs(settings.webhookRetryDelaysMs),
        pgDumpTimeoutSec: msToSec(settings.pgDumpTimeoutMs),
        maxUploadSizeMb: settings.maxUploadSizeMb,
        activeUserWindowMin: settings.activeUserWindowMin,
        registryMaxTags: settings.registryMaxTags,
        defaultLogLines: settings.defaultLogLines,
        agentCallbackUrl: settings.agentCallbackUrl || '',
        agentStaleThresholdSec: msToSec(settings.agentStaleThresholdMs),
        agentOfflineThresholdSec: msToSec(settings.agentOfflineThresholdMs),
        doRegistryToken: '',
        auditLogRetentionDays: settings.auditLogRetentionDays,
      });
      setDoRegistryTokenSet(settings.doRegistryTokenSet);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      const updateData: Parameters<typeof updateSystemSettings>[0] = {
        sshCommandTimeoutMs: secToMs(formData.sshCommandTimeoutSec),
        sshReadyTimeoutMs: secToMs(formData.sshReadyTimeoutSec),
        webhookMaxRetries: formData.webhookMaxRetries,
        webhookTimeoutMs: secToMs(formData.webhookTimeoutSec),
        webhookRetryDelaysMs: formatDelaysMs(formData.webhookRetryDelaysSec),
        pgDumpTimeoutMs: secToMs(formData.pgDumpTimeoutSec),
        maxUploadSizeMb: formData.maxUploadSizeMb,
        activeUserWindowMin: formData.activeUserWindowMin,
        registryMaxTags: formData.registryMaxTags,
        defaultLogLines: formData.defaultLogLines,
        agentCallbackUrl: formData.agentCallbackUrl || null,
        agentStaleThresholdMs: secToMs(formData.agentStaleThresholdSec),
        agentOfflineThresholdMs: secToMs(formData.agentOfflineThresholdSec),
        auditLogRetentionDays: formData.auditLogRetentionDays,
      };
      // Only include doRegistryToken if it was changed (non-empty)
      if (formData.doRegistryToken) {
        updateData.doRegistryToken = formData.doRegistryToken;
      }
      const { settings } = await updateSystemSettings(updateData);
      setDoRegistryTokenSet(settings.doRegistryTokenSet);
      setFormData(prev => ({ ...prev, doRegistryToken: '' }));

      setSuccess('Settings saved successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('Are you sure you want to reset all settings to defaults?')) {
      return;
    }

    try {
      setResetting(true);
      setError(null);
      setSuccess(null);

      const { settings } = await resetSystemSettings();
      setFormData({
        sshCommandTimeoutSec: msToSec(settings.sshCommandTimeoutMs),
        sshReadyTimeoutSec: msToSec(settings.sshReadyTimeoutMs),
        webhookMaxRetries: settings.webhookMaxRetries,
        webhookTimeoutSec: msToSec(settings.webhookTimeoutMs),
        webhookRetryDelaysSec: parseDelaysMs(settings.webhookRetryDelaysMs),
        pgDumpTimeoutSec: msToSec(settings.pgDumpTimeoutMs),
        maxUploadSizeMb: settings.maxUploadSizeMb,
        activeUserWindowMin: settings.activeUserWindowMin,
        registryMaxTags: settings.registryMaxTags,
        defaultLogLines: settings.defaultLogLines,
        agentCallbackUrl: settings.agentCallbackUrl || '',
        agentStaleThresholdSec: msToSec(settings.agentStaleThresholdMs),
        agentOfflineThresholdSec: msToSec(settings.agentOfflineThresholdMs),
        doRegistryToken: '',
        auditLogRetentionDays: settings.auditLogRetentionDays,
      });
      setDoRegistryTokenSet(settings.doRegistryTokenSet);

      setSuccess('Settings reset to defaults');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset settings');
    } finally {
      setResetting(false);
    }
  };

  const updateField = <K extends keyof FormData>(field: K, value: FormData[K]) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-slate-400">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">System Settings</h1>
        <p className="text-slate-400 mt-1">
          Configure global operational settings for BridgePort
        </p>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {success && (
        <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
          <p className="text-green-400">{success}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* SSH Configuration */}
        <SettingsSection title="SSH Configuration" icon={<SSHIcon />}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">
                Command Timeout
                <span className="text-slate-500 ml-1">(seconds)</span>
              </label>
              <input
                type="number"
                min={1}
                max={600}
                value={formData.sshCommandTimeoutSec}
                onChange={(e) => updateField('sshCommandTimeoutSec', parseInt(e.target.value) || 60)}
                className="input w-full"
              />
              <p className="text-xs text-slate-500 mt-1">
                Max time for SSH command execution (default: {defaults ? msToSec(defaults.sshCommandTimeoutMs) : 60}s)
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">
                Connection Timeout
                <span className="text-slate-500 ml-1">(seconds)</span>
              </label>
              <input
                type="number"
                min={1}
                max={120}
                value={formData.sshReadyTimeoutSec}
                onChange={(e) => updateField('sshReadyTimeoutSec', parseInt(e.target.value) || 10)}
                className="input w-full"
              />
              <p className="text-xs text-slate-500 mt-1">
                SSH connection establishment timeout (default: {defaults ? msToSec(defaults.sshReadyTimeoutMs) : 10}s)
              </p>
            </div>
          </div>
        </SettingsSection>

        {/* Webhook Delivery */}
        <SettingsSection title="Webhook Delivery" icon={<WebhookIcon />}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Max Retries</label>
              <input
                type="number"
                min={0}
                max={10}
                value={formData.webhookMaxRetries}
                onChange={(e) => updateField('webhookMaxRetries', parseInt(e.target.value) || 3)}
                className="input w-full"
              />
              <p className="text-xs text-slate-500 mt-1">
                Retry attempts for failed webhooks (default: {defaults?.webhookMaxRetries || 3})
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">
                Request Timeout
                <span className="text-slate-500 ml-1">(seconds)</span>
              </label>
              <input
                type="number"
                min={1}
                max={300}
                value={formData.webhookTimeoutSec}
                onChange={(e) => updateField('webhookTimeoutSec', parseInt(e.target.value) || 30)}
                className="input w-full"
              />
              <p className="text-xs text-slate-500 mt-1">
                HTTP timeout for webhook delivery (default: {defaults ? msToSec(defaults.webhookTimeoutMs) : 30}s)
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">
                Retry Delays
                <span className="text-slate-500 ml-1">(seconds, comma-separated)</span>
              </label>
              <input
                type="text"
                value={formData.webhookRetryDelaysSec}
                onChange={(e) => updateField('webhookRetryDelaysSec', e.target.value)}
                placeholder="1, 5, 15"
                className="input w-full"
              />
              <p className="text-xs text-slate-500 mt-1">
                Backoff delays between retries (default: {defaults ? parseDelaysMs(defaults.webhookRetryDelaysMs) : '1, 5, 15'})
              </p>
            </div>
          </div>
        </SettingsSection>

        {/* Registry Configuration */}
        <SettingsSection title="Registry Configuration" icon={<RegistryIcon />}>
          <div>
            <label className="block text-sm text-slate-400 mb-1">
              DigitalOcean Registry Token
            </label>
            <div className="relative">
              <input
                type="password"
                value={formData.doRegistryToken}
                onChange={(e) => updateField('doRegistryToken', e.target.value)}
                placeholder={doRegistryTokenSet ? '••••••••' : 'Enter token'}
                className="input w-full pr-20"
              />
              {doRegistryTokenSet && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-green-400">
                  Configured
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              API token for DigitalOcean Container Registry. Used for image pulls and tag listing.
              Leave empty to keep current value. Falls back to DO_REGISTRY_TOKEN env var if not set.
            </p>
          </div>
        </SettingsSection>

        {/* Agent Configuration */}
        <SettingsSection title="Agent Configuration" icon={<AgentIcon />}>
          <p className="text-slate-400 text-sm mb-4">
            Configure monitoring agents that push metrics from servers
          </p>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">
                Callback URL
                <span className="text-amber-500 ml-1">*</span>
              </label>
              <input
                type="text"
                value={formData.agentCallbackUrl}
                onChange={(e) => updateField('agentCallbackUrl', e.target.value)}
                placeholder="http://10.30.10.5:3000"
                className="input w-full"
              />
              <p className="text-xs text-slate-500 mt-1">
                Internal URL for agents to reach BridgePort. Use the VPC IP of the BridgePort server.
                <span className="text-amber-500 font-medium"> Required for agent deployment.</span>
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Stale Threshold
                  <span className="text-slate-500 ml-1">(seconds)</span>
                </label>
                <input
                  type="number"
                  min={60}
                  max={600}
                  value={formData.agentStaleThresholdSec}
                  onChange={(e) => updateField('agentStaleThresholdSec', parseInt(e.target.value) || 180)}
                  className="input w-full"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Mark agent as "stale" after no push for this time (default: {defaults ? msToSec(defaults.agentStaleThresholdMs) : 180}s)
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Offline Threshold
                  <span className="text-slate-500 ml-1">(seconds)</span>
                </label>
                <input
                  type="number"
                  min={120}
                  max={900}
                  value={formData.agentOfflineThresholdSec}
                  onChange={(e) => updateField('agentOfflineThresholdSec', parseInt(e.target.value) || 300)}
                  className="input w-full"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Mark agent as "offline" and alert after no push for this time (default: {defaults ? msToSec(defaults.agentOfflineThresholdMs) : 300}s)
                </p>
              </div>
            </div>
          </div>
        </SettingsSection>

        {/* Database Backup */}
        <SettingsSection title="Database Backup" icon={<DatabaseIcon />}>
          <div>
            <label className="block text-sm text-slate-400 mb-1">
              pg_dump Timeout
              <span className="text-slate-500 ml-1">(seconds)</span>
            </label>
            <input
              type="number"
              min={30}
              max={3600}
              value={formData.pgDumpTimeoutSec}
              onChange={(e) => updateField('pgDumpTimeoutSec', parseInt(e.target.value) || 300)}
              className="input w-48"
            />
            <p className="text-xs text-slate-500 mt-1">
              Max time for database backup execution (default: {defaults ? msToSec(defaults.pgDumpTimeoutMs) : 300}s / {defaults ? msToSec(defaults.pgDumpTimeoutMs) / 60 : 5} min)
            </p>
          </div>
        </SettingsSection>

        {/* Limits */}
        <SettingsSection title="Limits" icon={<LimitsIcon />}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">
                Max Upload Size
                <span className="text-slate-500 ml-1">(MB)</span>
              </label>
              <input
                type="number"
                min={1}
                max={500}
                value={formData.maxUploadSizeMb}
                onChange={(e) => updateField('maxUploadSizeMb', parseInt(e.target.value) || 50)}
                className="input w-full"
              />
              <p className="text-xs text-slate-500 mt-1">
                Maximum file upload size (default: {defaults?.maxUploadSizeMb || 50} MB)
              </p>
              <p className="text-xs text-amber-500 mt-1 flex items-center gap-1">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                Requires server restart to take effect
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">
                Active User Window
                <span className="text-slate-500 ml-1">(minutes)</span>
              </label>
              <input
                type="number"
                min={1}
                max={1440}
                value={formData.activeUserWindowMin}
                onChange={(e) => updateField('activeUserWindowMin', parseInt(e.target.value) || 15)}
                className="input w-full"
              />
              <p className="text-xs text-slate-500 mt-1">
                Window for "active user" status (default: {defaults?.activeUserWindowMin || 15} min)
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Registry Max Tags</label>
              <input
                type="number"
                min={10}
                max={500}
                value={formData.registryMaxTags}
                onChange={(e) => updateField('registryMaxTags', parseInt(e.target.value) || 50)}
                className="input w-full"
              />
              <p className="text-xs text-slate-500 mt-1">
                Maximum tags to fetch from registry (default: {defaults?.registryMaxTags || 50})
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Default Log Lines</label>
              <input
                type="number"
                min={10}
                max={10000}
                value={formData.defaultLogLines}
                onChange={(e) => updateField('defaultLogLines', parseInt(e.target.value) || 50)}
                className="input w-full"
              />
              <p className="text-xs text-slate-500 mt-1">
                Default tail lines for container logs (default: {defaults?.defaultLogLines || 50})
              </p>
            </div>
          </div>
        </SettingsSection>

        {/* Retention Policies */}
        <SettingsSection title="Retention Policies" icon={<RetentionIcon />}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">
                Audit Log Retention
                <span className="text-slate-500 ml-1">(days)</span>
              </label>
              <input
                type="number"
                min={0}
                max={3650}
                value={formData.auditLogRetentionDays}
                onChange={(e) => updateField('auditLogRetentionDays', parseInt(e.target.value) || 90)}
                className="input w-full"
              />
              <p className="text-xs text-slate-500 mt-1">
                Days to keep audit logs (default: {defaults?.auditLogRetentionDays || 90} days, 0 = keep forever)
              </p>
            </div>
          </div>
        </SettingsSection>

        {/* Actions */}
        <div className="flex items-center justify-between pt-4">
          <button
            type="button"
            onClick={handleReset}
            disabled={resetting || saving}
            className="btn btn-secondary"
          >
            {resetting ? 'Resetting...' : 'Reset to Defaults'}
          </button>
          <button
            type="submit"
            disabled={saving || resetting}
            className="btn btn-primary"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
