import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Trash2 } from 'lucide-react';
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
  getSentryStatus,
  testBackendSentry,
  type SmtpConfig,
  type SmtpConfigInput,
  type WebhookConfig,
  type WebhookConfigInput,
  type NotificationType,
  type Environment,
  type SlackChannel,
  type SlackChannelInput,
  type SlackRouting,
  type SentryStatus,
} from '../../lib/api';
import { useToast } from '../../components/Toast';
import { getErrorMessage, safeJsonParse } from '../../lib/helpers';
import { useSentryInitialized } from '../../lib/sentry';
import { useConfirm } from '@/hooks/useConfirm';
import { statusVariant } from '@/lib/status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

type TabType = 'smtp' | 'webhooks' | 'slack' | 'sentry' | 'types';

function msToSec(ms: number): number {
  return Math.round(ms / 1000);
}

function secToMs(sec: number): number {
  return sec * 1000;
}

function parseDelaysMs(delaysJson: string): string {
  const delays = safeJsonParse(delaysJson, [] as number[]);
  if (delays.length === 0) return '1, 5, 15';
  return delays.map((d) => Math.round(d / 1000)).join(', ');
}

// Single source of truth for parsing a comma-separated list of retry delays
// (seconds). Splits on comma, trims, and DROPS empty tokens (so a trailing
// comma is ignored rather than turning into a phantom delay). Returns an error
// string when the input can't be parsed into a non-empty list of positive
// integers; otherwise returns the parsed second values.
function parseDelaysSec(input: string): { values: number[]; error: string | null } {
  const parts = input.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    return { values: [], error: 'Enter at least one delay (in seconds).' };
  }
  const values: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return { values: [], error: `"${part}" is not a whole number of seconds.` };
    }
    const num = parseInt(part, 10);
    if (num < 1) {
      return { values: [], error: 'Delays must be at least 1 second.' };
    }
    values.push(num);
  }
  return { values, error: null };
}

function formatDelaysMs(delaysSec: string): string {
  const { values } = parseDelaysSec(delaysSec);
  return JSON.stringify(values.map((s) => s * 1000));
}

// Validate a comma-separated list of retry delays (seconds) and produce a
// human-readable preview. Returns an error string when the input can't be
// parsed into a non-empty list of positive integers, so save can be blocked.
function validateDelaysSec(delaysSec: string): { error: string | null; preview: string } {
  const { values, error } = parseDelaysSec(delaysSec);
  if (error) {
    return { error, preview: '' };
  }
  return { error: null, preview: values.map((v) => `${v}s`).join(', ') };
}

const webhookSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  url: z.string().min(1, 'URL is required').url('Enter a valid URL'),
  secret: z.string().optional(),
  enabled: z.boolean(),
});
type WebhookFormValues = z.infer<typeof webhookSchema>;

const slackChannelSchema = z.object({
  name: z.string().min(1, 'Display name is required'),
  slackChannelName: z.string().optional(),
  webhookUrl: z.string().optional(),
  isDefault: z.boolean(),
  enabled: z.boolean(),
});
type SlackChannelFormValues = z.infer<typeof slackChannelSchema>;

function SeverityBadge({ severity }: { severity: string }) {
  return <Badge variant={statusVariant('severity', severity)}>{severity}</Badge>;
}

export default function NotificationSettings() {
  const { user } = useAuthStore();
  const toast = useToast();
  const confirm = useConfirm();
  const sentryReady = useSentryInitialized();
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
    fromName: 'BRIDGEPORT',
    enabled: true,
  });
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpTesting, setSmtpTesting] = useState(false);
  const [testEmail, setTestEmail] = useState('');

  // Webhooks state
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [editingWebhook, setEditingWebhook] = useState<WebhookConfig | null>(null);
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState<string | null>(null);

  const webhookFormCtx = useForm<WebhookFormValues>({
    resolver: zodResolver(webhookSchema),
    defaultValues: { name: '', url: '', secret: '', enabled: true },
  });

  // Slack state
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([]);
  const [slackRoutings, setSlackRoutings] = useState<SlackRouting[]>([]);
  const [editingSlackChannel, setEditingSlackChannel] = useState<SlackChannel | null>(null);
  const [slackChannelSaving, setSlackChannelSaving] = useState(false);
  const [showSlackChannelModal, setShowSlackChannelModal] = useState(false);
  const [testingSlackChannel, setTestingSlackChannel] = useState<string | null>(null);

  const slackChannelFormCtx = useForm<SlackChannelFormValues>({
    resolver: zodResolver(slackChannelSchema),
    defaultValues: {
      name: '',
      slackChannelName: '',
      webhookUrl: '',
      isDefault: false,
      enabled: true,
    },
  });

  // Notification types state
  const [notificationTypes, setNotificationTypes] = useState<NotificationType[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_environments, setEnvironments] = useState<Environment[]>([]);

  // Sentry state
  const [sentryStatus, setSentryStatus] = useState<SentryStatus | null>(null);
  const [sentryTestingBackend, setSentryTestingBackend] = useState(false);
  const [sentryTestingFrontend, setSentryTestingFrontend] = useState(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [smtpRes, webhooksRes, typesRes, envsRes, systemRes, slackChannelsRes, slackRoutingsRes, sentryRes] = await Promise.all([
        getSmtpConfig(),
        listWebhooks(),
        getAdminNotificationTypes(),
        listEnvironments(),
        getSystemSettings(),
        listSlackChannels(),
        listSlackRoutings(),
        // Sentry is non-critical; don't block the page if status fails.
        getSentryStatus().catch(() => null),
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
      setSentryStatus(sentryRes);

      // Load webhook delivery settings
      setDeliverySettings({
        webhookMaxRetries: systemRes.settings.webhookMaxRetries,
        webhookTimeoutSec: msToSec(systemRes.settings.webhookTimeoutMs),
        webhookRetryDelaysSec: parseDelaysMs(systemRes.settings.webhookRetryDelaysMs),
      });
      setDeliverySettingsDefaults(systemRes.defaults);
    } catch (error) {
      // B7: surface load failures instead of leaving the page stuck on the
      // loading skeleton with no feedback.
      toast.error(getErrorMessage(error, 'Failed to load notification settings'));
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
      toast.error(getErrorMessage(error, 'Failed to save SMTP configuration'));
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
      toast.error(getErrorMessage(error, 'SMTP test failed'));
    } finally {
      setSmtpTesting(false);
    }
  };

  // Webhook handlers
  const openWebhookModal = (webhook?: WebhookConfig) => {
    if (webhook) {
      setEditingWebhook(webhook);
      webhookFormCtx.reset({
        name: webhook.name,
        url: webhook.url,
        secret: '',
        enabled: webhook.enabled,
      });
    } else {
      setEditingWebhook(null);
      webhookFormCtx.reset({ name: '', url: '', secret: '', enabled: true });
    }
    setShowWebhookModal(true);
  };

  const handleSaveWebhook = async (values: WebhookFormValues) => {
    setWebhookSaving(true);
    try {
      const payload: WebhookConfigInput = {
        name: values.name,
        url: values.url,
        secret: values.secret,
        enabled: values.enabled,
      };
      if (editingWebhook) {
        // Preserve existing typeFilter/environmentIds, which aren't edited here.
        payload.typeFilter = safeJsonParse(editingWebhook.typeFilter, undefined);
        payload.environmentIds = safeJsonParse(editingWebhook.environmentIds, undefined);
        const result = await updateWebhook(editingWebhook.id, payload);
        setWebhooks((prev) => prev.map((w) => (w.id === editingWebhook.id ? result.webhook : w)));
        toast.success('Webhook updated');
      } else {
        const result = await createWebhook(payload);
        setWebhooks((prev) => [...prev, result.webhook]);
        toast.success('Webhook created');
      }
      setShowWebhookModal(false);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save webhook'));
    } finally {
      setWebhookSaving(false);
    }
  };

  const handleDeleteWebhook = async (id: string) => {
    const ok = await confirm({
      title: 'Delete webhook?',
      description: 'Delete this webhook?',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
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
      toast.error(getErrorMessage(error, 'Webhook test failed'));
    } finally {
      setTestingWebhook(null);
    }
  };

  // Slack channel handlers
  const openSlackChannelModal = (channel?: SlackChannel) => {
    if (channel) {
      setEditingSlackChannel(channel);
      slackChannelFormCtx.reset({
        name: channel.name,
        slackChannelName: channel.slackChannelName || '',
        webhookUrl: '',
        isDefault: channel.isDefault,
        enabled: channel.enabled,
      });
    } else {
      setEditingSlackChannel(null);
      slackChannelFormCtx.reset({
        name: '',
        slackChannelName: '',
        webhookUrl: '',
        isDefault: false,
        enabled: true,
      });
    }
    setShowSlackChannelModal(true);
  };

  const handleSaveSlackChannel = async (values: SlackChannelFormValues) => {
    setSlackChannelSaving(true);
    try {
      if (editingSlackChannel) {
        // Only include webhookUrl if provided (for updates)
        const updateData: Partial<SlackChannelInput> = {
          name: values.name,
          slackChannelName: values.slackChannelName || undefined,
          isDefault: values.isDefault,
          enabled: values.enabled,
        };
        if (values.webhookUrl) {
          updateData.webhookUrl = values.webhookUrl;
        }
        const result = await updateSlackChannel(editingSlackChannel.id, updateData);
        setSlackChannels((prev) => prev.map((c) => (c.id === editingSlackChannel.id ? result.channel : c)));
        toast.success('Slack channel updated');
      } else {
        if (!values.webhookUrl) {
          toast.error('Webhook URL is required');
          setSlackChannelSaving(false);
          return;
        }
        const result = await createSlackChannel({
          name: values.name,
          slackChannelName: values.slackChannelName || undefined,
          webhookUrl: values.webhookUrl,
          isDefault: values.isDefault,
          enabled: values.enabled,
        });
        setSlackChannels((prev) => [...prev, result.channel]);
        toast.success('Slack channel created');
      }
      setShowSlackChannelModal(false);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save Slack channel'));
    } finally {
      setSlackChannelSaving(false);
    }
  };

  const handleDeleteSlackChannel = async (id: string) => {
    const ok = await confirm({
      title: 'Delete Slack channel?',
      description: 'Delete this Slack channel? All routing rules for this channel will also be removed.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
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
      toast.error(getErrorMessage(error, 'Slack test failed'));
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
      toast.error(getErrorMessage(error, 'Failed to update routing'));
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

  // Sentry test handlers
  const handleTestBackendSentry = async () => {
    setSentryTestingBackend(true);
    try {
      const result = await testBackendSentry();
      toast.success(result.message);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Backend Sentry test failed'));
    } finally {
      setSentryTestingBackend(false);
    }
  };

  // Throw asynchronously so the error escapes React's event-handler boundary
  // and reaches window.onerror — which is the integration Sentry's global
  // handler instruments. Capturing programmatically would only exercise the
  // manual capture path, not the real-world uncaught-error path.
  const handleTestFrontendSentry = () => {
    if (!sentryReady) {
      toast.error('Frontend Sentry SDK is not initialized yet. Try again in a moment.');
      return;
    }
    setSentryTestingFrontend(true);
    toast.success('Throwing a test error... check Sentry Issues in ~30s.');
    setTimeout(() => {
      throw new Error('BRIDGEPORT frontend Sentry test');
    }, 0);
  };

  // Webhook delivery settings handlers
  const handleSaveDeliverySettings = async () => {
    const { error: delaysError } = validateDelaysSec(deliverySettings.webhookRetryDelaysSec);
    if (delaysError) {
      toast.error(`Retry delays: ${delaysError}`);
      return;
    }
    setDeliverySaving(true);
    try {
      await updateSystemSettings({
        webhookMaxRetries: deliverySettings.webhookMaxRetries,
        webhookTimeoutMs: secToMs(deliverySettings.webhookTimeoutSec),
        webhookRetryDelaysMs: formatDelaysMs(deliverySettings.webhookRetryDelaysSec),
      });
      toast.success('Delivery settings saved');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save delivery settings'));
    } finally {
      setDeliverySaving(false);
    }
  };

  if (!isAdmin(user)) {
    return (
      <div className="p-8">
        <Card>
          <CardContent>
            <p className="text-center text-muted-foreground py-6">Admin access required</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  // Group notification types by category for Slack routing
  const systemTypes = notificationTypes.filter((t) => t.category === 'system');

  // Live validation + preview for the webhook retry-delays input
  const delaysValidation = validateDelaysSec(deliverySettings.webhookRetryDelaysSec);

  return (
    <div className="p-6">
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabType)} className="gap-6">
        <TabsList>
          <TabsTrigger value="smtp">Email (SMTP)</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="slack">Slack</TabsTrigger>
          <TabsTrigger value="sentry">Sentry</TabsTrigger>
          <TabsTrigger value="types">Notification Types</TabsTrigger>
        </TabsList>

        {/* SMTP Tab */}
        <TabsContent value="smtp">
          <Card>
            <CardHeader>
              <CardTitle>SMTP Configuration</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSaveSmtp} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="smtp-host">SMTP Host</Label>
                    <Input
                      id="smtp-host"
                      type="text"
                      value={smtpForm.host}
                      onChange={(e) => setSmtpForm({ ...smtpForm, host: e.target.value })}
                      placeholder="smtp.example.com"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="smtp-port">Port</Label>
                    <Input
                      id="smtp-port"
                      type="number"
                      value={smtpForm.port}
                      onChange={(e) => setSmtpForm({ ...smtpForm, port: parseInt(e.target.value) || 587 })}
                      required
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="smtp-username">Username</Label>
                    <Input
                      id="smtp-username"
                      type="text"
                      value={smtpForm.username}
                      onChange={(e) => setSmtpForm({ ...smtpForm, username: e.target.value })}
                      placeholder="Optional"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="smtp-password">Password</Label>
                    <Input
                      id="smtp-password"
                      type="password"
                      value={smtpForm.password}
                      onChange={(e) => setSmtpForm({ ...smtpForm, password: e.target.value })}
                      placeholder={smtpConfig?.hasPassword ? '••••••••' : 'Optional'}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="smtp-from-address">From Address</Label>
                    <Input
                      id="smtp-from-address"
                      type="email"
                      value={smtpForm.fromAddress}
                      onChange={(e) => setSmtpForm({ ...smtpForm, fromAddress: e.target.value })}
                      placeholder="noreply@example.com"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="smtp-from-name">From Name</Label>
                    <Input
                      id="smtp-from-name"
                      type="text"
                      value={smtpForm.fromName}
                      onChange={(e) => setSmtpForm({ ...smtpForm, fromName: e.target.value })}
                      placeholder="BRIDGEPORT"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-6">
                  <Label className="flex items-center gap-2">
                    <Checkbox
                      checked={smtpForm.secure}
                      onCheckedChange={(checked) => setSmtpForm({ ...smtpForm, secure: checked === true })}
                    />
                    <span className="text-sm">Use TLS/SSL</span>
                  </Label>
                  <Label className="flex items-center gap-2">
                    <Checkbox
                      checked={smtpForm.enabled}
                      onCheckedChange={(checked) => setSmtpForm({ ...smtpForm, enabled: checked === true })}
                    />
                    <span className="text-sm">Enabled</span>
                  </Label>
                </div>
                <div className="flex items-center gap-2 pt-2">
                  <Button type="submit" disabled={smtpSaving}>
                    {smtpSaving ? 'Saving...' : 'Save Configuration'}
                  </Button>
                </div>
              </form>

              {smtpConfig && (
                <div className="mt-6">
                  <Separator className="mb-6" />
                  <h4 className="text-sm font-medium text-foreground mb-3">Test SMTP</h4>
                  <div className="flex items-center gap-2">
                    <Input
                      type="email"
                      value={testEmail}
                      onChange={(e) => setTestEmail(e.target.value)}
                      placeholder="test@example.com (optional)"
                      className="flex-1"
                    />
                    <Button variant="secondary" onClick={handleTestSmtp} disabled={smtpTesting}>
                      {smtpTesting ? 'Testing...' : testEmail ? 'Send Test Email' : 'Test Connection'}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Webhooks Tab */}
        <TabsContent value="webhooks">
          <div className="space-y-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Outgoing Webhooks</CardTitle>
                <Button onClick={() => openWebhookModal()}>
                  <Plus className="size-4" />
                  Add Webhook
                </Button>
              </CardHeader>
              <CardContent>
                {webhooks.length === 0 ? (
                  <EmptyState message="No webhooks configured" />
                ) : (
                  <div className="space-y-3">
                    {webhooks.map((webhook) => (
                      <div key={webhook.id} className="p-4 bg-muted/40 rounded-lg">
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-foreground">{webhook.name}</h4>
                              <Badge variant={webhook.enabled ? 'success' : 'neutral'}>
                                {webhook.enabled ? 'Enabled' : 'Disabled'}
                              </Badge>
                              {webhook.hasSecret && <Badge variant="info">Signed</Badge>}
                            </div>
                            <p className="text-sm text-muted-foreground mt-1 font-mono">{webhook.url}</p>
                            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground/70">
                              <span>Success: {webhook.successCount}</span>
                              <span>Failed: {webhook.failureCount}</span>
                              {webhook.lastTriggeredAt && (
                                <span>Last: {new Date(webhook.lastTriggeredAt).toLocaleString()}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleTestWebhook(webhook.id)}
                              disabled={testingWebhook === webhook.id}
                              title="Send test notification"
                            >
                              {testingWebhook === webhook.id ? 'Testing...' : 'Test'}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openWebhookModal(webhook)}>
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => handleDeleteWebhook(webhook.id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Delivery Settings */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Delivery Settings</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="webhook-max-retries">Max Retries</Label>
                    <Input
                      id="webhook-max-retries"
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
                    />
                    <p className="text-xs text-muted-foreground">
                      Retry attempts for failed webhooks (default: {deliverySettingsDefaults?.webhookMaxRetries || 3})
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="webhook-timeout">
                      Request Timeout <span className="text-muted-foreground/70">(seconds)</span>
                    </Label>
                    <Input
                      id="webhook-timeout"
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
                    />
                    <p className="text-xs text-muted-foreground">
                      HTTP timeout for webhook delivery (default:{' '}
                      {deliverySettingsDefaults ? msToSec(deliverySettingsDefaults.webhookTimeoutMs) : 30}s)
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="webhook-retry-delays">
                      Retry Delays <span className="text-muted-foreground/70">(seconds, comma-separated)</span>
                    </Label>
                    <Input
                      id="webhook-retry-delays"
                      type="text"
                      value={deliverySettings.webhookRetryDelaysSec}
                      onChange={(e) =>
                        setDeliverySettings({
                          ...deliverySettings,
                          webhookRetryDelaysSec: e.target.value,
                        })
                      }
                      placeholder="1, 5, 15"
                      aria-invalid={delaysValidation.error ? true : undefined}
                    />
                    {delaysValidation.error ? (
                      <p className="text-xs text-destructive">{delaysValidation.error}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Parsed: {delaysValidation.preview}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Backoff delays between retries (default:{' '}
                      {deliverySettingsDefaults ? parseDelaysMs(deliverySettingsDefaults.webhookRetryDelaysMs) : '1, 5, 15'})
                    </p>
                  </div>
                </div>
                <Separator className="my-4" />
                <Button
                  onClick={handleSaveDeliverySettings}
                  disabled={deliverySaving || !!delaysValidation.error}
                >
                  {deliverySaving ? 'Saving...' : 'Save Delivery Settings'}
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Slack Tab */}
        <TabsContent value="slack">
          <div className="space-y-6">
            {/* Slack Channels */}
            <Card>
              <CardHeader className="flex flex-row items-start justify-between">
                <div className="space-y-1">
                  <CardTitle>Slack Channels</CardTitle>
                  <CardDescription>
                    Configure Slack incoming webhook URLs. Create a webhook in your Slack workspace and paste the URL here.
                  </CardDescription>
                </div>
                <Button onClick={() => openSlackChannelModal()}>
                  <Plus className="size-4" />
                  Add Channel
                </Button>
              </CardHeader>
              <CardContent>
                {slackChannels.length === 0 ? (
                  <EmptyState
                    message="No Slack channels configured"
                    description="Add a Slack incoming webhook to start receiving notifications in Slack."
                  />
                ) : (
                  <div className="space-y-3">
                    {slackChannels.map((channel) => (
                      <div key={channel.id} className="p-4 bg-muted/40 rounded-lg">
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-foreground">{channel.name}</h4>
                              {channel.slackChannelName && (
                                <span className="text-sm text-muted-foreground">{channel.slackChannelName}</span>
                              )}
                              <Badge variant={channel.enabled ? 'success' : 'neutral'}>
                                {channel.enabled ? 'Enabled' : 'Disabled'}
                              </Badge>
                              {channel.isDefault && <Badge variant="info">Default</Badge>}
                            </div>
                            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground/70">
                              {channel.hasWebhookUrl && <span>Webhook configured</span>}
                              {channel.lastTestedAt && (
                                <span>Last tested: {new Date(channel.lastTestedAt).toLocaleString()}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleTestSlackChannel(channel.id)}
                              disabled={testingSlackChannel === channel.id}
                              title="Send test message to Slack"
                            >
                              {testingSlackChannel === channel.id ? 'Testing...' : 'Test'}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openSlackChannelModal(channel)}>
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => handleDeleteSlackChannel(channel.id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Slack Routing */}
            {slackChannels.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Channel Routing</CardTitle>
                  <CardDescription>
                    Route notification types to specific Slack channels. Unrouted notifications use the default channel.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Notification Type</TableHead>
                        {slackChannels.map((channel) => (
                          <TableHead key={channel.id} className="text-center">
                            <div className="flex flex-col items-center">
                              <span>{channel.name}</span>
                              {channel.isDefault && (
                                <span className="text-xs text-info">(default)</span>
                              )}
                            </div>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {systemTypes.map((type) => {
                        const typeRoutings = slackRoutings.filter((r) => r.typeId === type.id);
                        return (
                          <TableRow key={type.id}>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <span className="text-foreground">{type.name}</span>
                                <SeverityBadge severity={type.severity} />
                              </div>
                            </TableCell>
                            {slackChannels.map((channel) => {
                              const isRouted = typeRoutings.some((r) => r.channelId === channel.id);
                              return (
                                <TableCell key={channel.id} className="text-center">
                                  <Checkbox
                                    checked={isRouted}
                                    onCheckedChange={(checked) =>
                                      handleRoutingChange(type.id, channel.id, checked === true)
                                    }
                                    aria-label={`Route ${type.name} to ${channel.name}`}
                                  />
                                </TableCell>
                              );
                            })}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* Sentry Tab */}
        <TabsContent value="sentry">
          <Card>
            <CardHeader>
              <CardTitle>Error Monitoring (Sentry)</CardTitle>
              <CardDescription>
                Sentry captures unhandled errors from the backend (Node) and frontend (React). Configure DSNs as environment variables and restart the container; values are picked up at runtime.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {/* Backend status */}
                <div className="p-4 bg-muted/40 rounded-lg">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-medium text-foreground">Backend (Node)</h4>
                        <Badge variant={sentryStatus?.backendConfigured ? 'success' : 'neutral'}>
                          {sentryStatus?.backendConfigured ? 'Configured' : 'Not configured'}
                        </Badge>
                      </div>
                      {sentryStatus?.backendConfigured ? (
                        <p className="text-sm text-muted-foreground mt-1">
                          Environment: <span className="text-foreground">{sentryStatus.environment}</span>
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground mt-1">
                          Set <code className="text-xs px-1 py-0.5 bg-background rounded text-foreground">SENTRY_BACKEND_DSN</code> and restart the container.
                        </p>
                      )}
                    </div>
                    {sentryStatus?.backendConfigured && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleTestBackendSentry}
                        disabled={sentryTestingBackend}
                        title="Capture a synthetic exception via the backend SDK"
                      >
                        {sentryTestingBackend ? 'Sending...' : 'Send test error'}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Frontend status */}
                <div className="p-4 bg-muted/40 rounded-lg">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-medium text-foreground">Frontend (React)</h4>
                        <Badge variant={sentryStatus?.frontendConfigured ? 'success' : 'neutral'}>
                          {sentryStatus?.frontendConfigured ? 'Configured' : 'Not configured'}
                        </Badge>
                        {sentryStatus?.frontendConfigured && !sentryReady && (
                          <Badge variant="warning">Initializing…</Badge>
                        )}
                      </div>
                      {sentryStatus?.frontendConfigured ? (
                        <p className="text-sm text-muted-foreground mt-1">
                          The DSN is served at runtime via <code className="text-xs px-1 py-0.5 bg-background rounded text-foreground">GET /api/client-config</code>; the SDK initializes on app load.
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground mt-1">
                          Set <code className="text-xs px-1 py-0.5 bg-background rounded text-foreground">SENTRY_FRONTEND_DSN</code> and restart the container.
                        </p>
                      )}
                    </div>
                    {sentryStatus?.frontendConfigured && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleTestFrontendSentry}
                        disabled={sentryTestingFrontend || !sentryReady}
                        title="Throw an uncaught error so the global handler reports it"
                      >
                        {sentryTestingFrontend ? 'Throwing...' : 'Send test error'}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Setup help (only shown when neither DSN is set) */}
                {sentryStatus && !sentryStatus.backendConfigured && !sentryStatus.frontendConfigured && (
                  <div className="p-4 border rounded-lg bg-muted/20">
                    <h4 className="text-sm font-medium text-foreground mb-2">How to set up</h4>
                    <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                      <li>Create a Sentry project for the backend (platform: Node.js, framework: Vanilla) and copy the DSN.</li>
                      <li>Create a second Sentry project for the frontend (platform: React) and copy that DSN.</li>
                      <li>
                        Add both to <code className="text-xs px-1 py-0.5 bg-background rounded text-foreground">.env</code> (or <code className="text-xs px-1 py-0.5 bg-background rounded text-foreground">docker/.env</code> in Docker deployments):
                        <pre className="mt-2 p-2 bg-background rounded text-xs text-foreground overflow-x-auto">{`SENTRY_BACKEND_DSN=https://<key>@<org>.ingest.sentry.io/<project1>
SENTRY_FRONTEND_DSN=https://<key>@<org>.ingest.sentry.io/<project2>
SENTRY_ENVIRONMENT=production`}</pre>
                      </li>
                      <li>Restart the BRIDGEPORT container. The values are picked up at startup; no rebuild needed.</li>
                      <li>Come back here and use the test buttons to confirm events reach Sentry.</li>
                    </ol>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notification Types Tab */}
        <TabsContent value="types">
          <div className="space-y-6">
            {/* System Notifications */}
            <Card>
              <CardHeader>
                <CardTitle>System Notifications</CardTitle>
                <CardDescription>
                  Configure which system notifications are enabled. Disabled notifications will not be sent.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {notificationTypes.filter((t) => t.category === 'system').map((type) => {
                    const channels = safeJsonParse(type.defaultChannels, [] as string[]);
                    return (
                      <div
                        key={type.id}
                        className={`p-4 bg-muted/40 rounded-lg ${!type.enabled ? 'opacity-60' : ''}`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-foreground">{type.name}</h4>
                              <SeverityBadge severity={type.severity} />
                            </div>
                            <p className="text-sm text-muted-foreground mt-1">{type.description}</p>
                            {type.enabled && (
                              <div className="flex items-center gap-2 mt-2">
                                {channels.map((ch) => (
                                  <Badge key={ch} variant="neutral">{ch}</Badge>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-3">
                            {/* Enable/Disable Toggle */}
                            <Switch
                              checked={type.enabled}
                              onCheckedChange={(checked) => handleUpdateType(type.id, { enabled: checked })}
                              title={type.enabled ? 'Disable notification' : 'Enable notification'}
                              aria-label={type.enabled ? 'Disable notification' : 'Enable notification'}
                            />

                            {/* Bounce Settings (only shown when enabled) */}
                            {type.enabled && (
                              <div className="text-sm">
                                <Label className="flex items-center gap-2 mb-2">
                                  <Checkbox
                                    checked={type.bounceEnabled}
                                    onCheckedChange={(checked) =>
                                      handleUpdateType(type.id, { bounceEnabled: checked === true })
                                    }
                                  />
                                  <span className="text-foreground text-xs">Bounce logic</span>
                                </Label>
                                {type.bounceEnabled && (
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <span>Threshold:</span>
                                    <Input
                                      type="number"
                                      value={type.bounceThreshold}
                                      onChange={(e) =>
                                        handleUpdateType(type.id, { bounceThreshold: parseInt(e.target.value) || 3 })
                                      }
                                      className="w-14 h-8 text-xs"
                                      min={1}
                                      max={100}
                                    />
                                    <span>Cooldown:</span>
                                    <Input
                                      type="number"
                                      value={type.bounceCooldown}
                                      onChange={(e) =>
                                        handleUpdateType(type.id, { bounceCooldown: parseInt(e.target.value) || 900 })
                                      }
                                      className="w-16 h-8 text-xs"
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
              </CardContent>
            </Card>

            {/* Account Notifications */}
            <Card>
              <CardHeader>
                <CardTitle>Account Notifications</CardTitle>
                <CardDescription>
                  These notifications are controlled by individual users in their account settings.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {notificationTypes.filter((t) => t.category === 'user').map((type) => {
                    const channels = safeJsonParse(type.defaultChannels, [] as string[]);
                    return (
                      <div key={type.id} className="p-4 bg-muted/40 rounded-lg">
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-foreground">{type.name}</h4>
                              <SeverityBadge severity={type.severity} />
                            </div>
                            <p className="text-sm text-muted-foreground mt-1">{type.description}</p>
                            <div className="flex items-center gap-2 mt-2">
                              {channels.map((ch) => (
                                <Badge key={ch} variant="neutral">{ch}</Badge>
                              ))}
                            </div>
                          </div>
                          <Badge variant="neutral">User-controlled</Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* Webhook Modal */}
      <Dialog open={showWebhookModal} onOpenChange={setShowWebhookModal}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingWebhook ? 'Edit Webhook' : 'Add Webhook'}</DialogTitle>
          </DialogHeader>
          <Form {...webhookFormCtx}>
            <form onSubmit={webhookFormCtx.handleSubmit(handleSaveWebhook)} className="space-y-4">
              <FormField
                control={webhookFormCtx.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="My Webhook" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={webhookFormCtx.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>URL</FormLabel>
                    <FormControl>
                      <Input type="url" placeholder="https://example.com/webhook" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={webhookFormCtx.control}
                name="secret"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Secret (for HMAC signing)</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder={editingWebhook?.hasSecret ? '••••••••' : 'Optional'}
                        {...field}
                        value={field.value ?? ''}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={webhookFormCtx.control}
                name="enabled"
                render={({ field }) => (
                  <FormItem>
                    <Label className="flex items-center gap-2">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={(checked) => field.onChange(checked === true)}
                        />
                      </FormControl>
                      <span className="text-sm">Enabled</span>
                    </Label>
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setShowWebhookModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={webhookSaving}>
                  {webhookSaving ? 'Saving...' : 'Save'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Slack Channel Modal */}
      <Dialog open={showSlackChannelModal} onOpenChange={setShowSlackChannelModal}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingSlackChannel ? 'Edit Slack Channel' : 'Add Slack Channel'}</DialogTitle>
          </DialogHeader>
          <Form {...slackChannelFormCtx}>
            <form onSubmit={slackChannelFormCtx.handleSubmit(handleSaveSlackChannel)} className="space-y-4">
              <FormField
                control={slackChannelFormCtx.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Alerts, Deployments" {...field} />
                    </FormControl>
                    <FormDescription>A friendly name for this channel configuration</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={slackChannelFormCtx.control}
                name="slackChannelName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Slack Channel Name (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., #alerts" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormDescription>The actual Slack channel name (for reference)</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={slackChannelFormCtx.control}
                name="webhookUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Webhook URL {!editingSlackChannel && <span className="text-destructive">*</span>}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="url"
                        placeholder={editingSlackChannel ? 'Leave empty to keep current URL' : 'https://hooks.slack.com/services/...'}
                        required={!editingSlackChannel}
                        {...field}
                        value={field.value ?? ''}
                      />
                    </FormControl>
                    <FormDescription>
                      {editingSlackChannel
                        ? 'Leave empty to keep the current webhook URL'
                        : 'Create an incoming webhook in your Slack workspace'}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex items-center gap-6">
                <FormField
                  control={slackChannelFormCtx.control}
                  name="isDefault"
                  render={({ field }) => (
                    <FormItem>
                      <Label className="flex items-center gap-2">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={(checked) => field.onChange(checked === true)}
                          />
                        </FormControl>
                        <span className="text-sm">Default channel</span>
                      </Label>
                    </FormItem>
                  )}
                />
                <FormField
                  control={slackChannelFormCtx.control}
                  name="enabled"
                  render={({ field }) => (
                    <FormItem>
                      <Label className="flex items-center gap-2">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={(checked) => field.onChange(checked === true)}
                          />
                        </FormControl>
                        <span className="text-sm">Enabled</span>
                      </Label>
                    </FormItem>
                  )}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                The default channel receives all notifications that don&apos;t have specific routing rules.
              </p>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setShowSlackChannelModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={slackChannelSaving}>
                  {slackChannelSaving ? 'Saving...' : 'Save'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
