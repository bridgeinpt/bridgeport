import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';
import {
  listRegistryConnections,
  createRegistryConnection,
  updateRegistryConnection,
  deleteRegistryConnection,
  testRegistryConnection,
  type RegistryConnection,
  type RegistryConnectionInput,
} from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

const REGISTRY_TYPES = [
  { value: 'digitalocean', label: 'DigitalOcean', url: 'https://api.digitalocean.com/v2/registry' },
  { value: 'dockerhub', label: 'Docker Hub', url: 'https://hub.docker.com' },
  { value: 'generic', label: 'Generic Registry', url: '' },
] as const;

export default function Registries() {
  const { selectedEnvironment } = useAppStore();
  const [registries, setRegistries] = useState<RegistryConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);

  // Form state
  const [formData, setFormData] = useState<RegistryConnectionInput>({
    name: '',
    type: 'digitalocean',
    registryUrl: 'https://api.digitalocean.com/v2/registry',
    repositoryPrefix: '',
    token: '',
    username: '',
    password: '',
    isDefault: false,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      listRegistryConnections(selectedEnvironment.id)
        .then(({ registries }) => setRegistries(registries))
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id]);

  const resetForm = () => {
    setFormData({
      name: '',
      type: 'digitalocean',
      registryUrl: 'https://api.digitalocean.com/v2/registry',
      repositoryPrefix: '',
      token: '',
      username: '',
      password: '',
      isDefault: false,
    });
  };

  const openCreate = () => {
    resetForm();
    setEditingId(null);
    setShowCreate(true);
  };

  const openEdit = (registry: RegistryConnection) => {
    setFormData({
      name: registry.name,
      type: registry.type,
      registryUrl: registry.registryUrl,
      repositoryPrefix: registry.repositoryPrefix || '',
      token: '', // Don't show existing token
      username: registry.username || '',
      password: '', // Don't show existing password
      isDefault: registry.isDefault,
    });
    setEditingId(registry.id);
    setShowCreate(true);
  };

  const handleTypeChange = (type: 'digitalocean' | 'dockerhub' | 'generic') => {
    const typeConfig = REGISTRY_TYPES.find((t) => t.value === type);
    setFormData({
      ...formData,
      type,
      registryUrl: typeConfig?.url || '',
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;

    setSaving(true);
    try {
      // Clean up empty optional fields
      const data: RegistryConnectionInput = {
        name: formData.name,
        type: formData.type,
        registryUrl: formData.registryUrl,
        isDefault: formData.isDefault,
      };
      if (formData.repositoryPrefix) data.repositoryPrefix = formData.repositoryPrefix;
      if (formData.token) data.token = formData.token;
      if (formData.username) data.username = formData.username;
      if (formData.password) data.password = formData.password;

      if (editingId) {
        const { registry } = await updateRegistryConnection(editingId, data);
        setRegistries((prev) =>
          prev.map((r) => (r.id === editingId ? registry : r))
        );
      } else {
        const { registry } = await createRegistryConnection(selectedEnvironment.id, data);
        setRegistries((prev) => [...prev, registry]);
      }
      setShowCreate(false);
      resetForm();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const registry = registries.find((r) => r.id === id);
    if (!registry) return;
    if (!confirm(`Delete registry connection "${registry.name}"?`)) return;

    try {
      await deleteRegistryConnection(id);
      setRegistries((prev) => prev.filter((r) => r.id !== id));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    setTestResult(null);
    try {
      const result = await testRegistryConnection(id);
      setTestResult({
        id,
        success: result.success,
        message: result.success ? 'Connection successful' : result.error || 'Connection failed',
      });
    } catch (error) {
      setTestResult({
        id,
        success: false,
        message: error instanceof Error ? error.message : 'Test failed',
      });
    } finally {
      setTesting(null);
    }
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-8">
        <div className="card text-center py-12">
          <p className="text-slate-400">Select an environment to view registries</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Registry Connections</h1>
          <p className="text-slate-400 mt-1">
            Manage container registry connections for {selectedEnvironment.name}
          </p>
        </div>
        <button onClick={openCreate} className="btn btn-primary">
          Add Registry
        </button>
      </div>

      {loading ? (
        <div className="card">
          <div className="animate-pulse space-y-4">
            <div className="h-12 bg-slate-700 rounded"></div>
            <div className="h-12 bg-slate-700 rounded"></div>
          </div>
        </div>
      ) : registries.length === 0 ? (
        <div className="card text-center py-12">
          <RegistryIcon className="w-12 h-12 text-slate-500 mx-auto mb-4" />
          <p className="text-slate-400 mb-4">No registry connections configured</p>
          <p className="text-slate-500 text-sm mb-4">
            Connect a container registry to enable automatic update checking for services
          </p>
          <button onClick={openCreate} className="btn btn-primary">
            Add Your First Registry
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {registries.map((registry) => (
            <div key={registry.id} className="card">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-slate-800 rounded-lg">
                    <RegistryIcon className="w-6 h-6 text-primary-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-white">{registry.name}</h3>
                      {registry.isDefault && (
                        <span className="badge badge-info text-xs">Default</span>
                      )}
                      <span className="badge bg-slate-700 text-slate-300 text-xs">
                        {REGISTRY_TYPES.find((t) => t.value === registry.type)?.label || registry.type}
                      </span>
                    </div>
                    <p className="text-slate-400 text-sm mt-1 font-mono">{registry.registryUrl}</p>
                    {registry.repositoryPrefix && (
                      <p className="text-slate-500 text-sm">Prefix: {registry.repositoryPrefix}</p>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                      <span>
                        {registry._count?.services || 0} service{registry._count?.services !== 1 ? 's' : ''}
                      </span>
                      <span>
                        Updated {formatDistanceToNow(new Date(registry.updatedAt), { addSuffix: true })}
                      </span>
                    </div>
                    {testResult?.id === registry.id && (
                      <div
                        className={`mt-2 text-sm ${
                          testResult.success ? 'text-green-400' : 'text-red-400'
                        }`}
                      >
                        {testResult.message}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleTest(registry.id)}
                    disabled={testing === registry.id}
                    className="btn btn-ghost text-sm"
                  >
                    {testing === registry.id ? 'Testing...' : 'Test'}
                  </button>
                  <button
                    onClick={() => openEdit(registry)}
                    className="btn btn-ghost text-sm"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(registry.id)}
                    className="btn btn-ghost text-sm text-red-400 hover:text-red-300"
                    disabled={(registry._count?.services || 0) > 0}
                    title={
                      (registry._count?.services || 0) > 0
                        ? 'Cannot delete registry with attached services'
                        : ''
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingId ? 'Edit Registry Connection' : 'Add Registry Connection'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="My Registry"
                  className="input"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Type</label>
                <select
                  value={formData.type}
                  onChange={(e) =>
                    handleTypeChange(e.target.value as 'digitalocean' | 'dockerhub' | 'generic')
                  }
                  className="input"
                >
                  {REGISTRY_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Registry URL</label>
                <input
                  type="text"
                  value={formData.registryUrl}
                  onChange={(e) => setFormData({ ...formData, registryUrl: e.target.value })}
                  placeholder="https://registry.example.com"
                  className="input font-mono text-sm"
                  required
                />
              </div>

              {formData.type === 'digitalocean' && (
                <div>
                  <label className="block text-sm text-slate-400 mb-1">
                    Repository Prefix (Registry Name)
                  </label>
                  <input
                    type="text"
                    value={formData.repositoryPrefix}
                    onChange={(e) => setFormData({ ...formData, repositoryPrefix: e.target.value })}
                    placeholder="bios-registry"
                    className="input font-mono text-sm"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    The registry name from DigitalOcean (e.g., bios-registry)
                  </p>
                </div>
              )}

              {formData.type === 'digitalocean' && (
                <div>
                  <label className="block text-sm text-slate-400 mb-1">API Token</label>
                  <input
                    type="password"
                    value={formData.token}
                    onChange={(e) => setFormData({ ...formData, token: e.target.value })}
                    placeholder={editingId ? '(unchanged)' : 'dop_v1_...'}
                    className="input font-mono text-sm"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    DigitalOcean API token with registry read access
                  </p>
                </div>
              )}

              {(formData.type === 'dockerhub' || formData.type === 'generic') && (
                <>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Username</label>
                    <input
                      type="text"
                      value={formData.username}
                      onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                      placeholder="username"
                      className="input"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Password / Token</label>
                    <input
                      type="password"
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      placeholder={editingId ? '(unchanged)' : 'password or access token'}
                      className="input"
                    />
                  </div>
                </>
              )}

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isDefault"
                  checked={formData.isDefault}
                  onChange={(e) => setFormData({ ...formData, isDefault: e.target.checked })}
                  className="rounded bg-slate-700 border-slate-600 text-primary-500 focus:ring-primary-500"
                />
                <label htmlFor="isDefault" className="text-sm text-slate-300">
                  Set as default registry for this environment
                </label>
              </div>

              <div className="flex gap-2 justify-end pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    resetForm();
                    setEditingId(null);
                  }}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="btn btn-primary">
                  {saving ? 'Saving...' : editingId ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function RegistryIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
      />
    </svg>
  );
}
