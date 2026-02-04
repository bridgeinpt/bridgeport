import { useEffect, useState } from 'react';
import { useAuthStore, isAdmin } from '../../lib/store';
import {
  listServiceTypes,
  createServiceType,
  deleteServiceType,
  addServiceTypeCommand,
  updateServiceTypeCommand,
  deleteServiceTypeCommand,
  type ServiceType,
  type ServiceTypeCommand,
} from '../../lib/api';
import { useToast } from '../../components/Toast';

export default function ServiceTypes() {
  const { user } = useAuthStore();
  const toast = useToast();
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedType, setExpandedType] = useState<string | null>(null);

  // Create type modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeDisplayName, setNewTypeDisplayName] = useState('');
  const [creating, setCreating] = useState(false);

  // Create command modal
  const [showCommandModal, setShowCommandModal] = useState(false);
  const [editingCommand, setEditingCommand] = useState<ServiceTypeCommand | null>(null);
  const [commandTypeId, setCommandTypeId] = useState<string | null>(null);
  const [commandForm, setCommandForm] = useState({
    name: '',
    displayName: '',
    command: '',
    description: '',
  });
  const [savingCommand, setSavingCommand] = useState(false);

  useEffect(() => {
    loadServiceTypes();
  }, []);

  const loadServiceTypes = async () => {
    setLoading(true);
    try {
      const { serviceTypes } = await listServiceTypes();
      setServiceTypes(serviceTypes);
    } catch (error) {
      toast.error('Failed to load service types');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateType = async () => {
    if (!newTypeName || !newTypeDisplayName) {
      toast.error('Please fill in all fields');
      return;
    }
    setCreating(true);
    try {
      await createServiceType({ name: newTypeName, displayName: newTypeDisplayName });
      toast.success('Service type created');
      setShowCreateModal(false);
      setNewTypeName('');
      setNewTypeDisplayName('');
      loadServiceTypes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create service type');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteType = async (typeId: string, typeName: string) => {
    if (!confirm(`Delete service type "${typeName}"? This cannot be undone.`)) return;
    try {
      await deleteServiceType(typeId);
      toast.success('Service type deleted');
      loadServiceTypes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete service type');
    }
  };

  const openCommandModal = (typeId: string, command?: ServiceTypeCommand) => {
    setCommandTypeId(typeId);
    setEditingCommand(command || null);
    setCommandForm({
      name: command?.name || '',
      displayName: command?.displayName || '',
      command: command?.command || '',
      description: command?.description || '',
    });
    setShowCommandModal(true);
  };

  const handleSaveCommand = async () => {
    if (!commandTypeId) return;
    if (!commandForm.name || !commandForm.displayName || !commandForm.command) {
      toast.error('Please fill in all required fields');
      return;
    }
    setSavingCommand(true);
    try {
      if (editingCommand) {
        await updateServiceTypeCommand(commandTypeId, editingCommand.id, {
          displayName: commandForm.displayName,
          command: commandForm.command,
          description: commandForm.description || undefined,
        });
        toast.success('Command updated');
      } else {
        await addServiceTypeCommand(commandTypeId, commandForm);
        toast.success('Command added');
      }
      setShowCommandModal(false);
      loadServiceTypes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save command');
    } finally {
      setSavingCommand(false);
    }
  };

  const handleDeleteCommand = async (typeId: string, commandId: string, commandName: string) => {
    if (!confirm(`Delete command "${commandName}"?`)) return;
    try {
      await deleteServiceTypeCommand(typeId, commandId);
      toast.success('Command deleted');
      loadServiceTypes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete command');
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-6"></div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Configure predefined commands for different service types (e.g., Django, Node.js)
        </p>
        {isAdmin(user) && (
          <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
            Add Service Type
          </button>
        )}
      </div>

      {serviceTypes.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-slate-400 mb-4">No service types configured</p>
          {isAdmin(user) && (
            <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
              Add Service Type
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {serviceTypes.map((type) => (
            <div key={type.id} className="card">
              <div
                className="flex items-center justify-between cursor-pointer"
                onClick={() => setExpandedType(expandedType === type.id ? null : type.id)}
              >
                <div className="flex items-center gap-3">
                  <svg
                    className={`w-5 h-5 text-slate-400 transition-transform ${
                      expandedType === type.id ? 'rotate-90' : ''
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <div>
                    <h3 className="font-medium text-white">{type.displayName}</h3>
                    <p className="text-sm text-slate-400">
                      {type.commands.length} command{type.commands.length !== 1 ? 's' : ''} |{' '}
                      {type._count?.services || 0} service{(type._count?.services || 0) !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  {isAdmin(user) && (
                    <>
                      <button
                        onClick={() => openCommandModal(type.id)}
                        className="btn btn-ghost text-sm"
                      >
                        Add Command
                      </button>
                      {(type._count?.services || 0) === 0 && (
                        <button
                          onClick={() => handleDeleteType(type.id, type.name)}
                          className="btn btn-ghost text-red-400 hover:text-red-300 text-sm"
                        >
                          Delete
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {expandedType === type.id && (
                <div className="mt-4 pt-4 border-t border-slate-700">
                  {type.commands.length === 0 ? (
                    <p className="text-slate-500 text-sm">No commands configured</p>
                  ) : (
                    <div className="space-y-2">
                      {type.commands.map((cmd) => (
                        <div
                          key={cmd.id}
                          className="flex items-center justify-between p-3 bg-slate-800 rounded-lg"
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-white">{cmd.displayName}</span>
                              <code className="text-xs bg-slate-700 px-2 py-0.5 rounded text-slate-300">
                                {cmd.name}
                              </code>
                            </div>
                            <code className="text-sm text-primary-400">{cmd.command}</code>
                            {cmd.description && (
                              <p className="text-sm text-slate-400 mt-1">{cmd.description}</p>
                            )}
                          </div>
                          {isAdmin(user) && (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => openCommandModal(type.id, cmd)}
                                className="text-slate-400 hover:text-white"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                              <button
                                onClick={() => handleDeleteCommand(type.id, cmd.id, cmd.name)}
                                className="text-slate-400 hover:text-red-400"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create Type Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md p-5">
            <h3 className="text-lg font-semibold text-white mb-4">Create Service Type</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Name (lowercase, no spaces)</label>
                <input
                  type="text"
                  value={newTypeName}
                  onChange={(e) => setNewTypeName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder="e.g., django, nodejs, ruby"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Display Name</label>
                <input
                  type="text"
                  value={newTypeDisplayName}
                  onChange={(e) => setNewTypeDisplayName(e.target.value)}
                  placeholder="e.g., Django, Node.js, Ruby on Rails"
                  className="input"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setShowCreateModal(false)} className="btn btn-ghost">
                  Cancel
                </button>
                <button onClick={handleCreateType} disabled={creating} className="btn btn-primary">
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Command Modal */}
      {showCommandModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md p-5">
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingCommand ? 'Edit Command' : 'Add Command'}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Name (lowercase, no spaces)</label>
                <input
                  type="text"
                  value={commandForm.name}
                  onChange={(e) => setCommandForm({ ...commandForm, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                  placeholder="e.g., shell, migrate"
                  className="input"
                  disabled={!!editingCommand}
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Display Name</label>
                <input
                  type="text"
                  value={commandForm.displayName}
                  onChange={(e) => setCommandForm({ ...commandForm, displayName: e.target.value })}
                  placeholder="e.g., Django Shell, Run Migrations"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Command</label>
                <input
                  type="text"
                  value={commandForm.command}
                  onChange={(e) => setCommandForm({ ...commandForm, command: e.target.value })}
                  placeholder="e.g., python manage.py shell"
                  className="input font-mono"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Description (optional)</label>
                <input
                  type="text"
                  value={commandForm.description}
                  onChange={(e) => setCommandForm({ ...commandForm, description: e.target.value })}
                  placeholder="Brief description of what this command does"
                  className="input"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setShowCommandModal(false)} className="btn btn-ghost">
                  Cancel
                </button>
                <button onClick={handleSaveCommand} disabled={savingCommand} className="btn btn-primary">
                  {savingCommand ? 'Saving...' : editingCommand ? 'Update' : 'Add'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
