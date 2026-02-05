import { useEffect, useState } from 'react';
import { useAuthStore, isAdmin } from '../../lib/store';
import {
  getSmtpConfig,
  saveSmtpConfig,
  testSmtpConnection,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  getAdminNotificationTypes,
  updateAdminNotificationType,
  listEnvironments,
  getSystemSettings,
  updateSystemSettings,
  listSlackChannels,
  createSlackChannel,
  updateSlackChannel,
  deleteSlackChannel,
  testSlackChannel,
  listSlackRoutings,
  updateSlackRoutings,
  type SmtpConfig,
  type SmtpConfigInput,
  type WebhookConfig,
  type WebhookConfigInput,
  type NotificationType,
  type Environment,
  type SlackChannel,
  type SlackChannelInput,
  type SlackRouting,
} from '../../lib/api';
import { useToast } from '../../components/Toast';
import { PlusIcon, TrashIcon } from '../../components/Icons';

type TabType = 'smtp' | 'webhooks' | 'slack' | 'types';

function msToSec(ms: number): number {
  return Math.round(ms / 1000);
}

function secToMs(sec: number): number {
  return sec * 1000;
}

function parseDelaysMs(delaysJson: string): string {
  try {
    const delays = JSON.parse(delaysJson) as number[];
    return delays.map((d) => Math.round(d / 1000)).join(', ');
  } catch {
    return '1, 5, 15';
  }
}

function formatDelaysMs(delaysSec: string): string {
  const delays = delaysSec.split(',').map((s) => {
    const num = parseInt(s.trim(), 10);
    return isNaN(num) ? 1000 : num * 1000;
  });
  return JSON.stringify(delays);
}

export default function NotificationSettings() {
  const { user } = useAuthStore();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<TabType>('smtp');
  const [loading, setLoading] = useState(true);

  // SMTP state
  const [smtpConfig, setSmtpConfig] = useState<SmtpConfig | null>(null);
  const [smtpForm, setSmtpForm] = useState<SmtpConfigInput>({
    host: '',
    port: 587,
    secure: false,
    username: '',
    password: '',
    fromAddress: '',
    fromName: 'BridgePort',
    enabled: true,
  });
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpTesting, setSmtpTesting] = useState(false);
  const [testEmail, setTestEmail] = useState('');

  // Webhooks state
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [editingWebhook, setEditingWebhook] = useState<WebhookConfig | null>(null);
  const [webhookForm, setWebhookForm] = useState<WebhookConfigInput>({
    name: '',
    url: '',
    secret: '',
    enabled: true,
  });
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState<string | null>(null);

  // Slack state
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([]);
  const [slackRoutings, setSlackRoutings] = useState<SlackRouting[]>([]);
  const [editingSlackChannel, setEditingSlackChannel] = useState<SlackChannel | null>(null);
  const [slackChannelForm, setSlackChannelForm] = useState<SlackChannelInput>({
    name: '',
    slackChannelName: '',
    webhookUrl: '',
    isDefault: false,
    enabled: true,
  });
  const [slackChannelSaving, setSlackChannelSaving] = useState(false);
  const [showSlackChannelModal, setShowSlackChannelModal] = useState(false);
  const [testingSlackChannel, setTestingSlackChannel] = useState<string | null>(null);

  // Notification types state
  const [notificationTypes, setNotificationTypes] = useState<NotificationType[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_environments, setEnvironments] = useState<Environment[]>([]);

  // Webhook delivery settings state
  const [deliverySettings, setDeliverySettings] = useState({
    webhookMaxRetries: 3,
    webhookTimeoutSec: 30,
    webhookRetryDelaysSec: '1, 5, 15',
  });
  const [deliverySettingsDefaults, setDeliverySettingsDefaults] = useState({
    webhookMaxRetries: 3,
    webhookTimeoutMs: 30000,
    webhookRetryDelaysMs: '[1000,5000,15000]',
  });
  const [deliverySaving, setDeliverySaving] = useState(false);

  useEffect(() => {
    if (!isAdmin(user)) return;
    loadData();
  }, [user]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [smtpRes, webhooksRes, typesRes, envsRes, systemRes, slackChannelsRes, slackRoutingsRes] = await Promise.all([
        getSmtpConfig(),
        listWebhooks(),
        getAdminNotificationTypes(),
        listEnvironments(),
        getSystemSettings(),
        listSlackChannels(),
        listSlackRoutings(),
      ]);

      setSmtpConfig(smtpRes.config);
      if (smtpRes.config) {
        setSmtpForm({
          host: smtpRes.config.host,
          port: smtpRes.config.port,
          secure: smtpRes.config.secure,
          username: smtpRes.config.username || '',
          password: '',
          fromAddress: smtpRes.config.fromAddress,
          fromName: smtpRes.config.fromName,
          enabled: smtpRes.config.enabled,
        });
      }

      setWebhooks(webhooksRes.webhooks);
      setNotificationTypes(typesRes.types);
      setEnvironments(envsRes.environments);
      setSlackChannels(slackChannelsRes.channels);
      setSlackRoutings(slackRoutingsRes.routings);

      // Load webhook delivery settings
      setDeliverySettings({
        webhookMaxRetries: systemRes.settings.webhookMaxRetries,
        webhookTimeoutSec: msToSec(systemRes.settings.webhookTimeoutMs),
        webhookRetryDelaysSec: parseDelaysMs(systemRes.settings.webhookRetryDelaysMs),
      });
      setDeliverySettingsDefaults(systemRes.defaults);
    } finally {
      setLoading(false);
    }
  };

  // SMTP handlers
  const handleSaveSmtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSmtpSaving(true);
    try {
      const result = await saveSmtpConfig(smtpForm);
      setSmtpConfig(result.config);
      toast.success('SMTP configuration saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save SMTP configuration');
    } finally {
      setSmtpSaving(false);
    }
  };

  const handleTestSmtp = async () => {
    setSmtpTesting(true);
    try {
      const result = await testSmtpConnection(testEmail || undefined);
      toast.success(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'SMTP test failed');
    } finally {
      setSmtpTesting(false);
    }
  };

  // Webhook handlers
  const openWebhookModal = (webhook?: WebhookConfig) => {
    if (webhook) {
      setEditingWebhook(webhook);
      setWebhookForm({
        name: webhook.name,
        url: webhook.url,
        secret: '',
        enabled: webhook.enabled,
        typeFilter: webhook.typeFilter ? JSON.parse(webhook.typeFilter) : undefined,
        environmentIds: webhook.environmentIds ? JSON.parse(webhook.environmentIds) : undefined,
      });
    } else {
      setEditingWebhook(null);
      setWebhookForm({ name: '', url: '', secret: '', enabled: true });
    }
    setShowWebhookModal(true);
  };

  const handleSaveWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    setWebhookSaving(true);
    try {
      if (editingWebhook) {
        const result = await updateWebhook(editingWebhook.id, webhookForm);
        setWebhooks((prev) => prev.map((w) => (w.id === editingWebhook.id ? result.webhook : w)));
        toast.success('Webhook updated');
      } else {
        const result = await createWebhook(webhookForm);
        setWebhooks((prev) => [...prev, result.webhook]);
        toast.success('Webhook created');
      }
      setShowWebhookModal(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save webhook');
    } finally {
      setWebhookSaving(false);
    }
  };

  const handleDeleteWebhook = async (id: string) => {
    if (!confirm('Delete this webhook?')) return;
    try {
      await deleteWebhook(id);
      setWebhooks((prev) => prev.filter((w) => w.id !== id));
      toast.success('Webhook deleted');
    } catch {
      toast.error('Failed to delete webhook');
    }
  };

  const handleTestWebhook = async (id: string) => {
    setTestingWebhook(id);
    try {
      const result = await testWebhook(id);
      toast.success(result.message);
      // Update lastTriggeredAt
      setWebhooks((prev) =>
        prev.map((w) => (w.id === id ? { ...w, lastTriggeredAt: new Date().toISOString() } : w))
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Webhook test failed');
    } finally {
      setTestingWebhook(null);
    }
  };

  // Slack channel handlers
  const openSlackChannelModal = (channel?: SlackChannel) => {
    if (channel) {
      setEditingSlackChannel(channel);
      setSlackChannelForm({
        name: channel.name,
        slackChannelName: channel.slackChannelName || '',
        webhookUrl: '',
        isDefault: channel.isDefault,
        enabled: channel.enabled,
      });
    } else {
      setEditingSlackChannel(null);
      setSlackChannelForm({
        name: '',
        slackChannelName: '',
        webhookUrl: '',
        isDefault: false,
        enabled: true,
      });
    }
    setShowSlackChannelModal(true);
  };

  const handleSaveSlackChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    setSlackChannelSaving(true);
    try {
      if (editingSlackChannel) {
        // Only include webhookUrl if provided (for updates)
        const updateData: Partial<SlackChannelInput> = {
          name: slackChannelForm.name,
          slackChannelName: slackChannelForm.slackChannelName || undefined,
          isDefault: slackChannelForm.isDefault,
          enabled: slackChannelForm.enabled,
        };
        if (slackChannelForm.webhookUrl) {
          updateData.webhookUrl = slackChannelForm.webhookUrl;
        }
        const result = await updateSlackChannel(editingSlackChannel.id, updateData);
        setSlackChannels((prev) => prev.map((c) => (c.id === editingSlackChannel.id ? result.channel : c)));
        toast.success('Slack channel updated');
      } else {
        if (!slackChannelForm.webhookUrl) {
          toast.error('Webhook URL is required');
          setSlackChannelSaving(false);
          return;
        }
        const result = await createSlackChannel(slackChannelForm);
        setSlackChannels((prev) => [...prev, result.channel]);
        toast.success('Slack channel created');
      }
      setShowSlackChannelModal(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save Slack channel');
    } finally {
      setSlackChannelSaving(false);
    }
  };

  const handleDeleteSlackChannel = async (id: string) => {
    if (!confirm('Delete this Slack channel? All routing rules for this channel will also be removed.')) return;
    try {
      await deleteSlackChannel(id);
      setSlackChannels((prev) => prev.filter((c) => c.id !== id));
      setSlackRoutings((prev) => prev.filter((r) => r.channelId !== id));
      toast.success('Slack channel deleted');
    } catch {
      toast.error('Failed to delete Slack channel');
    }
  };

  const handleTestSlackChannel = async (id: string) => {
    setTestingSlackChannel(id);
    try {
      const result = await testSlackChannel(id);
      toast.success(result.message);
      // Update lastTestedAt
      setSlackChannels((prev) =>
        prev.map((c) => (c.id === id ? { ...c, lastTestedAt: new Date().toISOString() } : c))
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Slack test failed');
    } finally {
      setTestingSlackChannel(null);
    }
  };

  // Slack routing handlers
  const handleRoutingChange = async (typeId: string, channelId: string, checked: boolean) => {
    const currentRoutings = slackRoutings.filter((r) => r.typeId === typeId);
    let newRoutings: Array<{ channelId: string; environmentIds?: string[] | null }>;

    if (checked) {
      newRoutings = [...currentRoutings.map((r) => ({ channelId: r.channelId })), { channelId }];
    } else {
      newRoutings = currentRoutings.filter((r) => r.channelId !== channelId).map((r) => ({ channelId: r.channelId }));
    }

    try {
      const result = await updateSlackRoutings(typeId, newRoutings);
      // Update local state
      setSlackRoutings((prev) => [...prev.filter((r) => r.typeId !== typeId), ...result.routings]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update routing');
    }
  };

  // Notification type handlers
  const handleUpdateType = async (
    id: string,
    data: { enabled?: boolean; bounceEnabled?: boolean; bounceThreshold?: number; bounceCooldown?: number }
  ) => {
    try {
      const result = await updateAdminNotificationType(id, data);
      setNotificationTypes((prev) => prev.map((t) => (t.id === id ? result.type : t)));
      toast.success('Updated');
    } catch {
      toast.error('Failed to update');
    }
  };

  // Webhook delivery settings handlers
  const handleSaveDeliverySettings = async () => {
    setDeliverySaving(true);
    try {
      await updateSystemSettings({
        webhookMaxRetries: deliverySettings.webhookMaxRetries,
        webhookTimeoutMs: secToMs(deliverySettings.webhookTimeoutSec),
        webhookRetryDelaysMs: formatDelaysMs(deliverySettings.webhookRetryDelaysSec),
      });
      toast.success('Delivery settings saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save delivery settings');
    } finally {
      setDeliverySaving(false);
    }
  };

  if (!isAdmin(user)) {
    return (
      <div className="p-8">
        <div className="card text-center py-12">
          <p className="text-slate-400">Admin access required</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-slate-700 rounded"></div>
          <div className="h-64 bg-slate-800 rounded-xl"></div>
        </div>
      </div>
    );
  }

  // Group notification types by category for Slack routing
  const systemTypes = notificationTypes.filter((t) => t.category === 'system');

  return (
    <div className="p-6">
      <div className="mb-5">
        <p className="text-slate-400">Configure email, webhooks, Slack, and notification types</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-700 mb-6">
        {[
          { id: 'smtp', label: 'Email (SMTP)' },
          { id: 'webhooks', label: 'Webhooks' },
          { id: 'slack', label: 'Slack' },
          { id: 'types', label: 'Notification Types' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as TabType)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              activeTab === tab.id
                ? 'border-brand-600 text-white'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* SMTP Tab */}
      {activeTab === 'smtp' && (
        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">SMTP Configuration</h3>
          <form onSubmit={handleSaveSmtp} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">SMTP Host</label>
                <input
                  type="text"
                  value={smtpForm.host}
                  onChange={(e) => setSmtpForm({ ...smtpForm, host: e.target.value })}
                  placeholder="smtp.example.com"
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Port</label>
                <input
                  type="number"
                  value={smtpForm.port}
                  onChange={(e) => setSmtpForm({ ...smtpForm, port: parseInt(e.target.value) || 587 })}
                  className="input"
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Username</label>
                <input
                  type="text"
                  value={smtpForm.username}
                  onChange={(e) => setSmtpForm({ ...smtpForm, username: e.target.value })}
                  placeholder="Optional"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Password</label>
                <input
                  type="password"
                  value={smtpForm.password}
                  onChange={(e) => setSmtpForm({ ...smtpForm, password: e.target.value })}
                  placeholder={smtpConfig?.hasPassword ? '••••••••' : 'Optional'}
                  className="input"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">From Address</label>
                <input
                  type="email"
                  value={smtpForm.fromAddress}
                  onChange={(e) => setSmtpForm({ ...smtpForm, fromAddress: e.target.value })}
                  placeholder="noreply@example.com"
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">From Name</label>
                <input
                  type="text"
                  value={smtpForm.fromName}
                  onChange={(e) => setSmtpForm({ ...smtpForm, fromName: e.target.value })}
                  placeholder="BridgePort"
                  className="input"
                />
              </div>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={smtpForm.secure}
                  onChange={(e) => setSmtpForm({ ...smtpForm, secure: e.target.checked })}
                  className="rounded bg-slate-800 border-slate-600 text-primary-500"
                />
                <span className="text-sm text-slate-300">Use TLS/SSL</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={smtpForm.enabled}
                  onChange={(e) => setSmtpForm({ ...smtpForm, enabled: e.target.checked })}
                  className="rounded bg-slate-800 border-slate-600 text-primary-500"
                />
                <span className="text-sm text-slate-300">Enabled</span>
              </label>
            </div>
            <div className="flex items-center gap-2 pt-2">
              <button type="submit" disabled={smtpSaving} className="btn btn-primary">
                {smtpSaving ? 'Saving...' : 'Save Configuration'}
              </button>
            </div>
          </form>

          {smtpConfig && (
            <div className="mt-6 pt-6 border-t border-slate-700">
              <h4 className="text-sm font-medium text-white mb-3">Test SMTP</h4>
              <div className="flex items-center gap-2">
                <input
                  type="email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  placeholder="test@example.com (optional)"
                  className="input flex-1"
                />
                <button
                  onClick={handleTestSmtp}
                  disabled={smtpTesting}
                  className="btn btn-secondary"
                >
                  {smtpTesting ? 'Testing...' : testEmail ? 'Send Test Email' : 'Test Connection'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Webhooks Tab */}
      {activeTab === 'webhooks' && (
        <div className="space-y-6">
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Outgoing Webhooks</h3>
              <button onClick={() => openWebhookModal()} className="btn btn-primary">
                <PlusIcon className="w-4 h-4 mr-2" />
                Add Webhook
              </button>
            </div>

            {webhooks.length === 0 ? (
              <p className="text-slate-400 text-center py-8">No webhooks configured</p>
            ) : (
              <div className="space-y-3">
                {webhooks.map((webhook) => (
                  <div key={webhook.id} className="p-4 bg-slate-800 rounded-lg">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium text-white">{webhook.name}</h4>
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              webhook.enabled ? 'bg-green-500/20 text-green-400' : 'bg-slate-700 text-slate-400'
                            }`}
                          >
                            {webhook.enabled ? 'Enabled' : 'Disabled'}
                          </span>
                          {webhook.hasSecret && (
                            <span className="text-xs px-2 py-0.5 rounded bg-primary-500/20 text-primary-400">
                              Signed
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-400 mt-1 font-mono">{webhook.url}</p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                          <span>Success: {webhook.successCount}</span>
                          <span>Failed: {webhook.failureCount}</span>
                          {webhook.lastTriggeredAt && (
                            <span>Last: {new Date(webhook.lastTriggeredAt).toLocaleString()}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleTestWebhook(webhook.id)}
                          disabled={testingWebhook === webhook.id}
                          className="btn btn-secondary text-xs"
                          title="Send test notification"
                        >
                          {testingWebhook === webhook.id ? 'Testing...' : 'Test'}
                        </button>
                        <button
                          onClick={() => openWebhookModal(webhook)}
                          className="btn btn-ghost text-xs"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteWebhook(webhook.id)}
                          className="btn btn-ghost text-xs text-red-400 hover:text-red-300"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Delivery Settings */}
          <div className="card">
            <h3 className="text-base font-semibold text-white mb-4">Delivery Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Max Retries</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={deliverySettings.webhookMaxRetries}
                  onChange={(e) =>
                    setDeliverySettings({
                      ...deliverySettings,
                      webhookMaxRetries: parseInt(e.target.value) || 3,
                    })
                  }
                  className="input w-full"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Retry attempts for failed webhooks (default: {deliverySettingsDefaults?.webhookMaxRetries || 3})
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Request Timeout <span className="text-slate-500">(seconds)</span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={300}
                  value={deliverySettings.webhookTimeoutSec}
                  onChange={(e) =>
                    setDeliverySettings({
                      ...deliverySettings,
                      webhookTimeoutSec: parseInt(e.target.value) || 30,
                    })
                  }
                  className="input w-full"
                />
                <p className="text-xs text-slate-500 mt-1">
                  HTTP timeout for webhook delivery (default:{' '}
                  {deliverySettingsDefaults ? msToSec(deliverySettingsDefaults.webhookTimeoutMs) : 30}s)
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Retry Delays <span className="text-slate-500">(seconds, comma-separated)</span>
                </label>
                <input
                  type="text"
                  value={deliverySettings.webhookRetryDelaysSec}
                  onChange={(e) =>
                    setDeliverySettings({
                      ...deliverySettings,
                      webhookRetryDelaysSec: e.target.value,
                    })
                  }
                  placeholder="1, 5, 15"
                  className="input w-full"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Backoff delays between retries (default:{' '}
                  {deliverySettingsDefaults ? parseDelaysMs(deliverySettingsDefaults.webhookRetryDelaysMs) : '1, 5, 15'})
                </p>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-slate-700">
              <button
                onClick={handleSaveDeliverySettings}
                disabled={deliverySaving}
                className="btn btn-primary"
              >
                {deliverySaving ? 'Saving...' : 'Save Delivery Settings'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Slack Tab */}
      {activeTab === 'slack' && (
        <div className="space-y-6">
          {/* Slack Channels */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-white">Slack Channels</h3>
                <p className="text-sm text-slate-400 mt-1">
                  Configure Slack incoming webhook URLs. Create a webhook in your Slack workspace and paste the URL here.
                </p>
              </div>
              <button onClick={() => openSlackChannelModal()} className="btn btn-primary">
                <PlusIcon className="w-4 h-4 mr-2" />
                Add Channel
              </button>
            </div>

            {slackChannels.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-slate-400 mb-2">No Slack channels configured</p>
                <p className="text-sm text-slate-500">
                  Add a Slack incoming webhook to start receiving notifications in Slack.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {slackChannels.map((channel) => (
                  <div key={channel.id} className="p-4 bg-slate-800 rounded-lg">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium text-white">{channel.name}</h4>
                          {channel.slackChannelName && (
                            <span className="text-sm text-slate-400">{channel.slackChannelName}</span>
                          )}
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              channel.enabled ? 'bg-green-500/20 text-green-400' : 'bg-slate-700 text-slate-400'
                            }`}
                          >
                            {channel.enabled ? 'Enabled' : 'Disabled'}
                          </span>
                          {channel.isDefault && (
                            <span className="text-xs px-2 py-0.5 rounded bg-primary-500/20 text-primary-400">
                              Default
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                          {channel.hasWebhookUrl && <span>Webhook configured</span>}
                          {channel.lastTestedAt && (
                            <span>Last tested: {new Date(channel.lastTestedAt).toLocaleString()}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleTestSlackChannel(channel.id)}
                          disabled={testingSlackChannel === channel.id}
                          className="btn btn-secondary text-xs"
                          title="Send test message to Slack"
                        >
                          {testingSlackChannel === channel.id ? 'Testing...' : 'Test'}
                        </button>
                        <button
                          onClick={() => openSlackChannelModal(channel)}
                          className="btn btn-ghost text-xs"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteSlackChannel(channel.id)}
                          className="btn btn-ghost text-xs text-red-400 hover:text-red-300"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Slack Routing */}
          {slackChannels.length > 0 && (
            <div className="card">
              <h3 className="text-lg font-semibold text-white mb-2">Channel Routing</h3>
              <p className="text-sm text-slate-400 mb-4">
                Route notification types to specific Slack channels. Unrouted notifications use the default channel.
              </p>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-700">
                      <th className="text-left text-sm font-medium text-slate-400 pb-3 pr-4">
                        Notification Type
                      </th>
                      {slackChannels.map((channel) => (
                        <th
                          key={channel.id}
                          className="text-center text-sm font-medium text-slate-400 pb-3 px-2"
                        >
                          <div className="flex flex-col items-center">
                            <span>{channel.name}</span>
                            {channel.isDefault && (
                              <span className="text-xs text-primary-400">(default)</span>
                            )}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {systemTypes.map((type) => {
                      const typeRoutings = slackRoutings.filter((r) => r.typeId === type.id);
                      return (
                        <tr key={type.id} className="border-b border-slate-800">
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-2">
                              <span className="text-white">{type.name}</span>
                              <span
                                className={`text-xs px-1.5 py-0.5 rounded ${
                                  type.severity === 'critical'
                                    ? 'bg-red-500/20 text-red-400'
                                    : type.severity === 'warning'
                                      ? 'bg-yellow-500/20 text-yellow-400'
                                      : 'bg-slate-700 text-slate-400'
                                }`}
                              >
                                {type.severity}
                              </span>
                            </div>
                          </td>
                          {slackChannels.map((channel) => {
                            const isRouted = typeRoutings.some((r) => r.channelId === channel.id);
                            return (
                              <td key={channel.id} className="py-3 px-2 text-center">
                                <input
                                  type="checkbox"
                                  checked={isRouted}
                                  onChange={(e) => handleRoutingChange(type.id, channel.id, e.target.checked)}
                                  className="rounded bg-slate-700 border-slate-600 text-primary-500"
                                />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Notification Types Tab */}
      {activeTab === 'types' && (
        <div className="space-y-6">
          {/* System Notifications */}
          <div className="card">
            <h3 className="text-lg font-semibold text-white mb-2">System Notifications</h3>
            <p className="text-sm text-slate-400 mb-4">
              Configure which system notifications are enabled. Disabled notifications will not be sent.
            </p>
            <div className="space-y-3">
              {notificationTypes.filter((t) => t.category === 'system').map((type) => {
                const channels = JSON.parse(type.defaultChannels || '[]') as string[];
                return (
                  <div key={type.id} className={`p-4 bg-slate-800 rounded-lg ${!type.enabled ? 'opacity-60' : ''}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium text-white">{type.name}</h4>
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              type.severity === 'critical'
                                ? 'bg-red-500/20 text-red-400'
                                : type.severity === 'warning'
                                  ? 'bg-yellow-500/20 text-yellow-400'
                                  : 'bg-primary-500/20 text-primary-400'
                            }`}
                          >
                            {type.severity}
                          </span>
                        </div>
                        <p className="text-sm text-slate-400 mt-1">{type.description}</p>
                        {type.enabled && (
                          <div className="flex items-center gap-2 mt-2">
                            {channels.map((ch) => (
                              <span key={ch} className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300">
                                {ch}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-3">
                        {/* Enable/Disable Toggle */}
                        <button
                          onClick={() => handleUpdateType(type.id, { enabled: !type.enabled })}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                            type.enabled ? 'bg-brand-600' : 'bg-slate-600'
                          }`}
                          title={type.enabled ? 'Disable notification' : 'Enable notification'}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              type.enabled ? 'translate-x-6' : 'translate-x-1'
                            }`}
                          />
                        </button>

                        {/* Bounce Settings (only shown when enabled) */}
                        {type.enabled && (
                          <div className="text-sm">
                            <label className="flex items-center gap-2 mb-2">
                              <input
                                type="checkbox"
                                checked={type.bounceEnabled}
                                onChange={(e) => handleUpdateType(type.id, { bounceEnabled: e.target.checked })}
                                className="rounded bg-slate-700 border-slate-600 text-primary-500"
                              />
                              <span className="text-slate-300 text-xs">Bounce logic</span>
                            </label>
                            {type.bounceEnabled && (
                              <div className="flex items-center gap-2 text-xs text-slate-400">
                                <span>Threshold:</span>
                                <input
                                  type="number"
                                  value={type.bounceThreshold}
                                  onChange={(e) =>
                                    handleUpdateType(type.id, { bounceThreshold: parseInt(e.target.value) || 3 })
                                  }
                                  className="w-14 px-2 py-1 bg-slate-700 border border-slate-600 rounded text-white text-xs"
                                  min={1}
                                  max={100}
                                />
                                <span>Cooldown:</span>
                                <input
                                  type="number"
                                  value={type.bounceCooldown}
                                  onChange={(e) =>
                                    handleUpdateType(type.id, { bounceCooldown: parseInt(e.target.value) || 900 })
                                  }
                                  className="w-16 px-2 py-1 bg-slate-700 border border-slate-600 rounded text-white text-xs"
                                  min={60}
                                  max={86400}
                                />
                                <span>s</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Account Notifications */}
          <div className="card">
            <h3 className="text-lg font-semibold text-white mb-2">Account Notifications</h3>
            <p className="text-sm text-slate-400 mb-4">
              These notifications are controlled by individual users in their account settings.
            </p>
            <div className="space-y-3">
              {notificationTypes.filter((t) => t.category === 'user').map((type) => {
                const channels = JSON.parse(type.defaultChannels || '[]') as string[];
                return (
                  <div key={type.id} className="p-4 bg-slate-800 rounded-lg">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium text-white">{type.name}</h4>
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              type.severity === 'critical'
                                ? 'bg-red-500/20 text-red-400'
                                : type.severity === 'warning'
                                  ? 'bg-yellow-500/20 text-yellow-400'
                                  : 'bg-primary-500/20 text-primary-400'
                            }`}
                          >
                            {type.severity}
                          </span>
                        </div>
                        <p className="text-sm text-slate-400 mt-1">{type.description}</p>
                        <div className="flex items-center gap-2 mt-2">
                          {channels.map((ch) => (
                            <span key={ch} className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300">
                              {ch}
                            </span>
                          ))}
                        </div>
                      </div>
                      <span className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-400">
                        User-controlled
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Webhook Modal */}
      {showWebhookModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingWebhook ? 'Edit Webhook' : 'Add Webhook'}
            </h3>
            <form onSubmit={handleSaveWebhook} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Name</label>
                <input
                  type="text"
                  value={webhookForm.name}
                  onChange={(e) => setWebhookForm({ ...webhookForm, name: e.target.value })}
                  placeholder="My Webhook"
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">URL</label>
                <input
                  type="url"
                  value={webhookForm.url}
                  onChange={(e) => setWebhookForm({ ...webhookForm, url: e.target.value })}
                  placeholder="https://example.com/webhook"
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Secret (for HMAC signing)
                </label>
                <input
                  type="password"
                  value={webhookForm.secret}
                  onChange={(e) => setWebhookForm({ ...webhookForm, secret: e.target.value })}
                  placeholder={editingWebhook?.hasSecret ? '••••••••' : 'Optional'}
                  className="input"
                />
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={webhookForm.enabled}
                  onChange={(e) => setWebhookForm({ ...webhookForm, enabled: e.target.checked })}
                  className="rounded bg-slate-800 border-slate-600 text-primary-500"
                />
                <span className="text-sm text-slate-300">Enabled</span>
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowWebhookModal(false)}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={webhookSaving} className="btn btn-primary">
                  {webhookSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Slack Channel Modal */}
      {showSlackChannelModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingSlackChannel ? 'Edit Slack Channel' : 'Add Slack Channel'}
            </h3>
            <form onSubmit={handleSaveSlackChannel} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Display Name</label>
                <input
                  type="text"
                  value={slackChannelForm.name}
                  onChange={(e) => setSlackChannelForm({ ...slackChannelForm, name: e.target.value })}
                  placeholder="e.g., Alerts, Deployments"
                  className="input"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">A friendly name for this channel configuration</p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Slack Channel Name (optional)</label>
                <input
                  type="text"
                  value={slackChannelForm.slackChannelName || ''}
                  onChange={(e) => setSlackChannelForm({ ...slackChannelForm, slackChannelName: e.target.value })}
                  placeholder="e.g., #alerts"
                  className="input"
                />
                <p className="text-xs text-slate-500 mt-1">The actual Slack channel name (for reference)</p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Webhook URL {!editingSlackChannel && <span className="text-red-400">*</span>}
                </label>
                <input
                  type="url"
                  value={slackChannelForm.webhookUrl}
                  onChange={(e) => setSlackChannelForm({ ...slackChannelForm, webhookUrl: e.target.value })}
                  placeholder={editingSlackChannel ? 'Leave empty to keep current URL' : 'https://hooks.slack.com/services/...'}
                  className="input"
                  required={!editingSlackChannel}
                />
                <p className="text-xs text-slate-500 mt-1">
                  {editingSlackChannel
                    ? 'Leave empty to keep the current webhook URL'
                    : 'Create an incoming webhook in your Slack workspace'}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={slackChannelForm.isDefault}
                    onChange={(e) => setSlackChannelForm({ ...slackChannelForm, isDefault: e.target.checked })}
                    className="rounded bg-slate-800 border-slate-600 text-primary-500"
                  />
                  <span className="text-sm text-slate-300">Default channel</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={slackChannelForm.enabled}
                    onChange={(e) => setSlackChannelForm({ ...slackChannelForm, enabled: e.target.checked })}
                    className="rounded bg-slate-800 border-slate-600 text-primary-500"
                  />
                  <span className="text-sm text-slate-300">Enabled</span>
                </label>
              </div>
              <p className="text-xs text-slate-500">
                The default channel receives all notifications that don&apos;t have specific routing rules.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowSlackChannelModal(false)}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={slackChannelSaving} className="btn btn-primary">
                  {slackChannelSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
