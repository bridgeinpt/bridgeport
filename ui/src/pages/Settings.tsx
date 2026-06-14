import { useEffect, useState, useCallback, useRef } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { useAppStore, isAdmin } from '../lib/store';
import { useAuthStore } from '../lib/store';
import {
  getModuleSettings,
  updateModuleSettings,
  resetModuleSettings,
  getSshStatus,
  listServers,
  getEnvNotificationSettings,
  updateEnvNotificationSettings,
  testEnvNotificationChannel,
  type SettingDefinition,
  type SettingsModule,
  type Server,
  type SshStatus,
  type EnvNotificationChannel,
  type EnvNotificationSettings,
} from '../lib/api';
import { useToast } from '../components/Toast';
import { SshKeyModal } from '../components/SshKeyModal';
import { EmptyState } from '@/components/ui/empty-state';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Panel } from '@/components/ui/page-header';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const TABS: { key: string; label: string; module?: SettingsModule }[] = [
  { key: 'general', label: 'General', module: 'general' },
  { key: 'operations', label: 'Operations', module: 'operations' },
  { key: 'monitoring', label: 'Monitoring', module: 'monitoring' },
  { key: 'orchestration', label: 'Orchestration' },
  { key: 'data', label: 'Data', module: 'data' },
  { key: 'configuration', label: 'Configuration', module: 'configuration' },
  { key: 'notifications', label: 'Notifications' },
];

interface TabData {
  settings: Record<string, unknown>;
  definitions: SettingDefinition[];
}

function getInitialTab(): string {
  const hash = window.location.hash.replace('#', '');
  if (TABS.some((t) => t.key === hash)) return hash;
  return 'general';
}

export default function Settings() {
  const { selectedEnvironment } = useAppStore();
  const { user } = useAuthStore();
  const toast = useToast();
  const confirm = useConfirm();

  const [activeTab, setActiveTab] = useState(getInitialTab);
  const [tabCache, setTabCache] = useState<Record<string, TabData>>({});
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // General tab extras
  const [sshStatus, setSshStatus] = useState<SshStatus | null>(null);
  const [sshModalOpen, setSshModalOpen] = useState(false);
  const [servers, setServers] = useState<Server[]>([]);
  const [generalLoading, setGeneralLoading] = useState(false);

  // Track which tab's data is currently displayed in formData
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const currentTabDef = TABS.find((t) => t.key === activeTab);
  const currentModule = currentTabDef?.module;

  // Determine if form has changes
  const cachedData = tabCache[activeTab];
  const hasChanges = cachedData
    ? Object.keys(formData).some((key) => formData[key] !== cachedData.settings[key])
    : false;

  const loadTabData = useCallback(
    async (tabKey: string) => {
      if (!selectedEnvironment?.id) return;
      const tab = TABS.find((t) => t.key === tabKey);
      if (!tab?.module) return;

      // Already cached
      if (tabCache[tabKey]) {
        setFormData({ ...tabCache[tabKey].settings });
        return;
      }

      setLoading(true);
      try {
        const result = await getModuleSettings(selectedEnvironment.id, tab.module);
        const data: TabData = { settings: result.settings, definitions: result.definitions };
        setTabCache((prev) => ({ ...prev, [tabKey]: data }));
        if (activeTabRef.current === tabKey) {
          setFormData({ ...result.settings });
        }
      } catch (error) {
        toast.error(`Failed to load ${tab.label} settings`);
      } finally {
        setLoading(false);
      }
    },
    [selectedEnvironment?.id, tabCache, toast]
  );

  const loadGeneralExtras = useCallback(async () => {
    if (!selectedEnvironment?.id) return;
    setGeneralLoading(true);
    try {
      const [sshRes, serversRes] = await Promise.all([
        getSshStatus(selectedEnvironment.id),
        listServers(selectedEnvironment.id),
      ]);
      setSshStatus(sshRes);
      setServers(serversRes.servers);
    } finally {
      setGeneralLoading(false);
    }
  }, [selectedEnvironment?.id]);

  // Load tab data when active tab or environment changes
  useEffect(() => {
    // Clear cache on env change
    setTabCache({});
    setFormData({});
    setSshStatus(null);
    setServers([]);
  }, [selectedEnvironment?.id]);

  useEffect(() => {
    if (currentModule) {
      loadTabData(activeTab);
    }
    if (activeTab === 'general') {
      loadGeneralExtras();
    }
  }, [activeTab, selectedEnvironment?.id, loadTabData, loadGeneralExtras, currentModule]);

  const switchTab = async (newTab: string) => {
    if (hasChanges) {
      const ok = await confirm({
        title: 'Discard unsaved changes?',
        description: 'You have unsaved changes. Discard them?',
        confirmText: 'Discard',
        destructive: true,
      });
      if (!ok) return;
    }
    setActiveTab(newTab);
    window.location.hash = newTab;
  };

  const handleChange = (key: string, value: unknown) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    if (!selectedEnvironment?.id || !currentModule || !cachedData) return;
    setSaving(true);
    try {
      // Only send changed values
      const changed: Record<string, unknown> = {};
      for (const key of Object.keys(formData)) {
        if (formData[key] !== cachedData.settings[key]) {
          changed[key] = formData[key];
        }
      }
      if (Object.keys(changed).length === 0) return;

      const result = await updateModuleSettings(selectedEnvironment.id, currentModule, changed);
      const newData: TabData = { settings: result.settings, definitions: cachedData.definitions };
      setTabCache((prev) => ({ ...prev, [activeTab]: newData }));
      setFormData({ ...result.settings });
      toast.success('Settings saved');
    } catch (error) {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!selectedEnvironment?.id || !currentModule) return;
    const ok = await confirm({
      title: 'Reset settings?',
      description: 'Reset all settings in this tab to their defaults?',
      confirmText: 'Reset',
      destructive: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      const result = await resetModuleSettings(selectedEnvironment.id, currentModule);
      // Refetch definitions since they don't change, but we need fresh settings
      const freshData = await getModuleSettings(selectedEnvironment.id, currentModule);
      const newData: TabData = { settings: result.settings, definitions: freshData.definitions };
      setTabCache((prev) => ({ ...prev, [activeTab]: newData }));
      setFormData({ ...result.settings });
      toast.success('Settings reset to defaults');
    } catch (error) {
      toast.error('Failed to reset settings');
    } finally {
      setSaving(false);
    }
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-8">
        <Panel className="text-center py-12">
          <p className="text-muted-foreground">Please select an environment</p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Tabs */}
      <div className="border-b border-border mb-6">
        <nav className="flex gap-6 -mb-px">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => switchTab(tab.key)}
              className={cn(
                'pb-3 text-sm font-medium border-b-2 transition-colors',
                activeTab === tab.key
                  ? 'border-brand text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'orchestration' ? (
        <EmptyState
          icon={SettingsIcon}
          message="No settings configured for this module yet."
        />
      ) : activeTab === 'notifications' ? (
        <NotificationsSection
          environmentId={selectedEnvironment.id}
          isUserAdmin={isAdmin(user)}
        />
      ) : loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : cachedData ? (
        <div className="space-y-8">
          {/* General tab: SSH config + Environment info */}
          {activeTab === 'general' && (
            <>
              <SshSection
                sshStatus={sshStatus}
                isUserAdmin={isAdmin(user)}
                onOpenModal={() => setSshModalOpen(true)}
                loading={generalLoading}
              />
              <SshKeyModal
                isOpen={sshModalOpen}
                onClose={() => setSshModalOpen(false)}
                onUpdate={() => {
                  loadGeneralExtras();
                  setSshModalOpen(false);
                }}
                currentSshUser={sshStatus?.sshUser || 'root'}
                testServerId={servers.length > 0 ? servers[0].id : undefined}
              />
              <EnvironmentInfo environment={selectedEnvironment} />
            </>
          )}

          {/* Grouped settings widgets */}
          <SettingsGroups
            definitions={cachedData.definitions}
            formData={formData}
            onChange={handleChange}
            disabled={!isAdmin(user)}
          />

          {/* Save/Reset bar */}
          {isAdmin(user) ? (
            <div className="flex justify-between pt-6 border-t border-border">
              <Button variant="ghost" size="sm" onClick={handleReset} disabled={saving}>
                Reset to Defaults
              </Button>
              <Button size="sm" onClick={handleSave} disabled={!hasChanges || saving}>
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground pt-4">
              Only administrators can modify environment settings.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

function SettingsGroups({
  definitions,
  formData,
  onChange,
  disabled,
}: {
  definitions: SettingDefinition[];
  formData: Record<string, unknown>;
  onChange: (key: string, val: unknown) => void;
  disabled: boolean;
}) {
  // Group definitions by group field
  const grouped: Record<string, SettingDefinition[]> = {};
  for (const def of definitions) {
    const group = def.group || 'General';
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(def);
  }

  return (
    <>
      {Object.entries(grouped).map(([groupName, defs]) => (
        <div key={groupName} className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            {groupName}
          </h3>
          <div className="space-y-4">
            {defs.map((def) => (
              <SettingWidget
                key={def.key}
                def={def}
                value={formData[def.key]}
                onChange={onChange}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function SettingWidget({
  def,
  value,
  onChange,
  disabled,
}: {
  def: SettingDefinition;
  value: unknown;
  onChange: (key: string, val: unknown) => void;
  disabled: boolean;
}) {
  switch (def.widget) {
    case 'toggle':
      return (
        <div
          className={cn(
            'flex items-center gap-3',
            disabled && 'opacity-50'
          )}
        >
          <Switch
            id={`setting-${def.key}`}
            checked={value as boolean}
            onCheckedChange={(checked) => onChange(def.key, checked)}
            disabled={disabled}
          />
          <Label htmlFor={`setting-${def.key}`} className="flex-col items-start gap-0">
            <span className="text-sm text-foreground">{def.label}</span>
            <span className="text-xs font-normal text-muted-foreground">{def.description}</span>
          </Label>
        </div>
      );
    case 'number':
      return (
        <div className="space-y-1">
          <Label htmlFor={`setting-${def.key}`} className="text-foreground">
            {def.label}
          </Label>
          <p className="text-xs text-muted-foreground pb-1">{def.description}</p>
          <Input
            id={`setting-${def.key}`}
            type="number"
            value={value as number}
            min={def.min}
            max={def.max}
            onChange={(e) => onChange(def.key, parseInt(e.target.value, 10))}
            disabled={disabled}
          />
        </div>
      );
    case 'select':
      return (
        <div className="space-y-1">
          <Label htmlFor={`setting-${def.key}`} className="text-foreground">
            {def.label}
          </Label>
          <p className="text-xs text-muted-foreground pb-1">{def.description}</p>
          <Select
            value={value as string}
            onValueChange={(val) => onChange(def.key, val)}
            disabled={disabled}
          >
            <SelectTrigger id={`setting-${def.key}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {def.options?.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    case 'text':
      return (
        <div className="space-y-1">
          <Label htmlFor={`setting-${def.key}`} className="text-foreground">
            {def.label}
          </Label>
          <p className="text-xs text-muted-foreground pb-1">{def.description}</p>
          <Input
            id={`setting-${def.key}`}
            type="text"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(def.key, e.target.value)}
            disabled={disabled}
          />
        </div>
      );
    default:
      return null;
  }
}

function SshSection({
  sshStatus,
  isUserAdmin,
  onOpenModal,
  loading,
}: {
  sshStatus: SshStatus | null;
  isUserAdmin: boolean;
  onOpenModal: () => void;
  loading: boolean;
}) {
  if (loading) {
    return (
      <Panel>
        <Skeleton className="h-12" />
      </Panel>
    );
  }

  return (
    <Panel>
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
        SSH Configuration
      </h3>
      <div className="p-4 bg-muted/50 rounded-lg">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-foreground">SSH Key</p>
            <p className="text-sm text-muted-foreground">
              {sshStatus?.configured ? (
                <>
                  Configured (user: <span className="text-foreground">{sshStatus.sshUser}</span>)
                </>
              ) : (
                'Not configured. Required for SSH-based operations.'
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge
              kind="health"
              value={sshStatus?.configured ? 'healthy' : 'warning'}
              label={sshStatus?.configured ? 'Configured' : 'Not Set'}
            />
            {isUserAdmin && (
              <Button variant="secondary" size="sm" onClick={onOpenModal}>
                {sshStatus?.configured ? 'Update' : 'Configure'}
              </Button>
            )}
          </div>
        </div>
        {!sshStatus?.configured && (
          <p className="text-xs text-muted-foreground mt-3">
            SSH access is required for server health checks, deployments, metrics collection, and
            agent deployment.
          </p>
        )}
      </div>
    </Panel>
  );
}

function EnvironmentInfo({ environment }: { environment: { id: string; name: string; _count: { servers: number; secrets: number } } }) {
  return (
    <Panel>
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
        Environment Info
      </h3>
      <dl className="space-y-3">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="text-foreground font-medium">{environment.name}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Servers</dt>
          <dd className="text-foreground">{environment._count?.servers ?? 0}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Secrets</dt>
          <dd className="text-foreground">{environment._count?.secrets ?? 0}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">ID</dt>
          <dd className="text-muted-foreground font-mono text-sm">{environment.id}</dd>
        </div>
      </dl>
    </Panel>
  );
}

function channelLabel(channel: EnvNotificationChannel | null | undefined): string {
  if (!channel) return '';
  if (channel.slackChannelName) {
    return `${channel.name} (${channel.slackChannelName})`;
  }
  return channel.name;
}

// Sentinel value for the "Inherit default" option — Radix Select can't use an
// empty-string item value, so we map '' (clear override) <-> this sentinel.
const INHERIT_DEFAULT = '__inherit__';

function NotificationsSection({
  environmentId,
  isUserAdmin,
}: {
  environmentId: string;
  isUserAdmin: boolean;
}) {
  const toast = useToast();
  const [data, setData] = useState<EnvNotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // Selection: '' = "Inherit default" (clears the override). A channel id
  // sets the override to that channel.
  const [selected, setSelected] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getEnvNotificationSettings(environmentId);
      setData(res);
      setSelected(res.settings.slackChannelId ?? '');
    } catch (err) {
      toast.error('Failed to load notification settings');
    } finally {
      setLoading(false);
    }
  }, [environmentId, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  const currentChannelId = data.settings.slackChannelId;
  const hasChange = (selected || null) !== currentChannelId;
  const hasOverride = !!currentChannelId;
  const noChannelsConfigured = data.channels.length === 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await updateEnvNotificationSettings(environmentId, {
        slackChannelId: selected ? selected : null,
      });
      setData({ ...data, settings: result.settings });
      setSelected(result.settings.slackChannelId ?? '');
      toast.success('Notification settings saved');
    } catch (err) {
      toast.error('Failed to save notification settings');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await testEnvNotificationChannel(environmentId);
      if (result.success) {
        toast.success('Test message sent to Slack');
      } else {
        toast.error(result.error || 'Test failed');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test failed';
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Panel>
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
          Slack Channel
        </h3>

        {noChannelsConfigured ? (
          <div className="p-4 bg-warning/10 border border-warning/30 rounded-lg text-sm text-foreground">
            No Slack channels are configured yet. Add channels under{' '}
            <span className="font-medium">Admin → Slack</span> to override the default for this
            environment.
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground mb-4">
              Pick this environment's Slack channel. When a notification type is routed to{' '}
              <strong>more than one</strong> channel, this environment's copy goes here only — so you
              can split shared alerts per environment (and mute one). It's also the fallback for types
              that match no routing rule. Types routed to a single channel are unaffected. Leave on{' '}
              <em>Inherit default</em> to use the global default channel.
            </p>

            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="slack-channel" className="text-foreground">
                  Channel
                </Label>
                <Select
                  value={selected || INHERIT_DEFAULT}
                  onValueChange={(val) => setSelected(val === INHERIT_DEFAULT ? '' : val)}
                  disabled={!isUserAdmin}
                >
                  <SelectTrigger id="slack-channel" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_DEFAULT}>
                      Inherit default
                      {data.defaultChannel ? `: ${channelLabel(data.defaultChannel)}` : ''}
                    </SelectItem>
                    {data.channels.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {channelLabel(c)}
                        {c.isDefault ? ' — default' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="text-xs">
                {hasOverride ? (
                  <StatusBadge kind="health" value="info" variant="info" label="Override active" />
                ) : (
                  <StatusBadge kind="health" value="neutral" variant="neutral" label="Using global default" />
                )}
              </div>
            </div>

            {isUserAdmin ? (
              <div className="flex justify-between items-center mt-6 pt-4 border-t border-border">
                <Button variant="ghost" size="sm" onClick={handleTest} disabled={testing || saving}>
                  {testing ? 'Sending…' : 'Send Test Message'}
                </Button>
                <Button size="sm" onClick={handleSave} disabled={!hasChange || saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground pt-4">
                Only administrators can modify notification settings.
              </p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
