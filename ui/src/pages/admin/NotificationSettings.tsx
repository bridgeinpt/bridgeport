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
  type SmtpConfig,
  type SmtpConfigInput,
  type WebhookConfig,
  type WebhookConfigInput,
  type NotificationType,
  type Environment,
} from '../../lib/api';
import { useToast } from '../../components/Toast';
import { PlusIcon, TrashIcon, RefreshIcon } from '../../components/Icons';

type TabType = 'smtp' | 'webhooks' | 'types';

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

  // Notification types state
  const [notificationTypes, setNotificationTypes] = useState<NotificationType[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_environments, setEnvironments] = useState<Environment[]>([]);

  useEffect(() => {
    if (!isAdmin(user)) return;
    loadData();
  }, [user]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [smtpRes, webhooksRes, typesRes, envsRes] = await Promise.all([
        getSmtpConfig(),
        listWebhooks(),
        getAdminNotificationTypes(),
        listEnvironments(),
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
    } catch (error) {
      toast.error('Failed to delete webhook');
    }
  };

  const handleTestWebhook = async (id: string) => {
    try {
      const result = await testWebhook(id);
      toast.success(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Webhook test failed');
    }
  };

  // Notification type handlers
  const handleUpdateType = async (
    id: string,
    data: { bounceEnabled?: boolean; bounceThreshold?: number; bounceCooldown?: number }
  ) => {
    try {
      const result = await updateAdminNotificationType(id, data);
      setNotificationTypes((prev) => prev.map((t) => (t.id === id ? result.type : t)));
      toast.success('Updated');
    } catch (error) {
      toast.error('Failed to update');
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

  return (
    <div className="p-6">
      <div className="mb-5">
        <p className="text-slate-400">Configure email, webhooks, and notification types</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-700 mb-6">
        {[
          { id: 'smtp', label: 'Email (SMTP)' },
          { id: 'webhooks', label: 'Webhooks' },
          { id: 'types', label: 'Notification Types' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as TabType)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab.id
                ? 'border-primary-500 text-primary-400'
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
                        className="btn btn-ghost text-xs"
                        title="Test webhook"
                      >
                        <RefreshIcon className="w-4 h-4" />
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
      )}

      {/* Notification Types Tab */}
      {activeTab === 'types' && (
        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Notification Types</h3>
          <div className="space-y-3">
            {notificationTypes.map((type) => {
              const channels = JSON.parse(type.defaultChannels || '[]') as string[];
              return (
                <div key={type.id} className="p-4 bg-slate-800 rounded-lg">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-medium text-white">{type.name}</h4>
                        <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-400">
                          {type.category}
                        </span>
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
                    {type.category === 'system' && (
                      <div className="text-sm">
                        <label className="flex items-center gap-2 mb-2">
                          <input
                            type="checkbox"
                            checked={type.bounceEnabled}
                            onChange={(e) => handleUpdateType(type.id, { bounceEnabled: e.target.checked })}
                            className="rounded bg-slate-700 border-slate-600 text-primary-500"
                          />
                          <span className="text-slate-300">Bounce logic</span>
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
                              className="w-16 px-2 py-1 bg-slate-700 border border-slate-600 rounded text-white"
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
                              className="w-20 px-2 py-1 bg-slate-700 border border-slate-600 rounded text-white"
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
              );
            })}
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
    </div>
  );
}
