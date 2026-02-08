import { useEffect, useState, useCallback, useRef } from 'react';
import { useAppStore, isAdmin } from '../lib/store';
import { useAuthStore } from '../lib/store';
import {
  getModuleSettings,
  updateModuleSettings,
  resetModuleSettings,
  getSshStatus,
  listServers,
  type SettingDefinition,
  type SettingsModule,
  type Server,
  type SshStatus,
} from '../lib/api';
import { useToast } from '../components/Toast';
import { SshKeyModal } from '../components/SshKeyModal';
import { EmptyState } from '../components/EmptyState.js';
import { SettingsIcon } from '../components/Icons';

const TABS: { key: string; label: string; module?: SettingsModule }[] = [
  { key: 'general', label: 'General', module: 'general' },
  { key: 'operations', label: 'Operations', module: 'operations' },
  { key: 'monitoring', label: 'Monitoring', module: 'monitoring' },
  { key: 'orchestration', label: 'Orchestration' },
  { key: 'data', label: 'Data', module: 'data' },
  { key: 'configuration', label: 'Configuration', module: 'configuration' },
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

  const switchTab = (newTab: string) => {
    if (hasChanges) {
      if (!confirm('You have unsaved changes. Discard?')) return;
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
    if (!confirm('Reset all settings in this tab to their defaults?')) return;
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
        <div className="panel text-center py-12">
          <p className="text-slate-400">Please select an environment</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Tabs */}
      <div className="border-b border-slate-700 mb-6">
        <nav className="flex gap-6 -mb-px">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => switchTab(tab.key)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-brand-600 text-white'
                  : 'border-transparent text-slate-400 hover:text-white hover:border-slate-500'
              }`}
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
      ) : loading ? (
        <div className="animate-pulse">
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
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
            <div className="flex justify-between pt-6 border-t border-slate-700">
              <button
                onClick={handleReset}
                className="btn btn-ghost text-sm"
                disabled={saving}
              >
                Reset to Defaults
              </button>
              <button
                onClick={handleSave}
                className="btn btn-primary text-sm"
                disabled={!hasChanges || saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          ) : (
            <p className="text-sm text-slate-500 pt-4">
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
          <h3 className="text-sm font-medium text-slate-300 uppercase tracking-wider">
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
        <label className={`flex items-center gap-3 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
          <input
            type="checkbox"
            checked={value as boolean}
            onChange={(e) => onChange(def.key, e.target.checked)}
            disabled={disabled}
            className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-brand-600 focus:ring-brand-500"
          />
          <div>
            <div className="text-sm text-white">{def.label}</div>
            <div className="text-xs text-slate-400">{def.description}</div>
          </div>
        </label>
      );
    case 'number':
      return (
        <div>
          <label className="block text-sm text-white mb-1">{def.label}</label>
          <p className="text-xs text-slate-400 mb-2">{def.description}</p>
          <input
            type="number"
            value={value as number}
            min={def.min}
            max={def.max}
            onChange={(e) => onChange(def.key, parseInt(e.target.value, 10))}
            disabled={disabled}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
          />
        </div>
      );
    case 'select':
      return (
        <div>
          <label className="block text-sm text-white mb-1">{def.label}</label>
          <p className="text-xs text-slate-400 mb-2">{def.description}</p>
          <select
            value={value as string}
            onChange={(e) => onChange(def.key, e.target.value)}
            disabled={disabled}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
          >
            {def.options?.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      );
    case 'text':
      return (
        <div>
          <label className="block text-sm text-white mb-1">{def.label}</label>
          <p className="text-xs text-slate-400 mb-2">{def.description}</p>
          <input
            type="text"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(def.key, e.target.value)}
            disabled={disabled}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
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
      <div className="panel animate-pulse">
        <div className="h-12 bg-slate-800 rounded"></div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3 className="text-sm font-medium text-slate-300 uppercase tracking-wider mb-4">
        SSH Configuration
      </h3>
      <div className="p-4 bg-slate-800 rounded-lg">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-white">SSH Key</p>
            <p className="text-sm text-slate-400">
              {sshStatus?.configured ? (
                <>
                  Configured (user: <span className="text-white">{sshStatus.sshUser}</span>)
                </>
              ) : (
                'Not configured. Required for SSH-based operations.'
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`px-2 py-1 rounded text-xs font-medium ${
                sshStatus?.configured
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-yellow-500/20 text-yellow-400'
              }`}
            >
              {sshStatus?.configured ? 'Configured' : 'Not Set'}
            </span>
            {isUserAdmin && (
              <button onClick={onOpenModal} className="btn btn-secondary btn-sm">
                {sshStatus?.configured ? 'Update' : 'Configure'}
              </button>
            )}
          </div>
        </div>
        {!sshStatus?.configured && (
          <p className="text-xs text-slate-500 mt-3">
            SSH access is required for server health checks, deployments, metrics collection, and
            agent deployment.
          </p>
        )}
      </div>
    </div>
  );
}

function EnvironmentInfo({ environment }: { environment: { id: string; name: string; _count: { servers: number; secrets: number } } }) {
  return (
    <div className="panel">
      <h3 className="text-sm font-medium text-slate-300 uppercase tracking-wider mb-4">
        Environment Info
      </h3>
      <dl className="space-y-3">
        <div className="flex justify-between">
          <dt className="text-slate-400">Name</dt>
          <dd className="text-white font-medium">{environment.name}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-400">Servers</dt>
          <dd className="text-white">{environment._count?.servers ?? 0}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-400">Secrets</dt>
          <dd className="text-white">{environment._count?.secrets ?? 0}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-400">ID</dt>
          <dd className="text-slate-400 font-mono text-sm">{environment.id}</dd>
        </div>
      </dl>
    </div>
  );
}
