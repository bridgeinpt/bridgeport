import { useEffect, useState } from 'react';
import { useAuthStore, isAdmin } from '../../lib/store';
import {
  listDatabaseTypes,
  createDatabaseType,
  deleteDatabaseType,
  addDatabaseTypeCommand,
  updateDatabaseTypeCommand,
  deleteDatabaseTypeCommand,
  resetDatabaseTypeDefaults,
  exportDatabaseTypeJson,
  type DatabaseTypeRecord,
  type DatabaseTypeCommand,
  type DatabaseTypeField,
} from '../../lib/api';
import { useToast } from '../../components/Toast';

export default function DatabaseTypes() {
  const { user } = useAuthStore();
  const toast = useToast();
  const [databaseTypes, setDatabaseTypes] = useState<DatabaseTypeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedType, setExpandedType] = useState<string | null>(null);

  // Create type modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeDisplayName, setNewTypeDisplayName] = useState('');
  const [newTypeDefaultPort, setNewTypeDefaultPort] = useState('');
  const [newTypeConnectionFields, setNewTypeConnectionFields] = useState('');
  const [newTypeBackupCommand, setNewTypeBackupCommand] = useState('');
  const [newTypeRestoreCommand, setNewTypeRestoreCommand] = useState('');
  const [creating, setCreating] = useState(false);

  // Create command modal
  const [showCommandModal, setShowCommandModal] = useState(false);
  const [editingCommand, setEditingCommand] = useState<DatabaseTypeCommand | null>(null);
  const [commandTypeId, setCommandTypeId] = useState<string | null>(null);
  const [commandForm, setCommandForm] = useState({
    name: '',
    displayName: '',
    command: '',
    description: '',
  });
  const [savingCommand, setSavingCommand] = useState(false);

  useEffect(() => {
    loadDatabaseTypes();
  }, []);

  const loadDatabaseTypes = async () => {
    setLoading(true);
    try {
      const { databaseTypes } = await listDatabaseTypes();
      setDatabaseTypes(databaseTypes);
    } catch (error) {
      toast.error('Failed to load database types');
    } finally {
      setLoading(false);
    }
  };

  const parseConnectionFields = (jsonStr: string): DatabaseTypeField[] => {
    try {
      return JSON.parse(jsonStr) as DatabaseTypeField[];
    } catch {
      return [];
    }
  };

  const handleCreateType = async () => {
    if (!newTypeName || !newTypeDisplayName) {
      toast.error('Please fill in name and display name');
      return;
    }

    let connectionFields: DatabaseTypeField[] = [];
    if (newTypeConnectionFields.trim()) {
      try {
        connectionFields = JSON.parse(newTypeConnectionFields);
        if (!Array.isArray(connectionFields)) {
          toast.error('Connection fields must be a JSON array');
          return;
        }
      } catch {
        toast.error('Invalid JSON for connection fields');
        return;
      }
    }

    setCreating(true);
    try {
      await createDatabaseType({
        name: newTypeName,
        displayName: newTypeDisplayName,
        defaultPort: newTypeDefaultPort ? parseInt(newTypeDefaultPort, 10) : undefined,
        connectionFields,
        backupCommand: newTypeBackupCommand || undefined,
        restoreCommand: newTypeRestoreCommand || undefined,
      });
      toast.success('Database type created');
      setShowCreateModal(false);
      setNewTypeName('');
      setNewTypeDisplayName('');
      setNewTypeDefaultPort('');
      setNewTypeConnectionFields('');
      setNewTypeBackupCommand('');
      setNewTypeRestoreCommand('');
      loadDatabaseTypes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create database type');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteType = async (typeId: string, typeName: string) => {
    if (!confirm(`Delete database type "${typeName}"? This cannot be undone.`)) return;
    try {
      await deleteDatabaseType(typeId);
      toast.success('Database type deleted');
      loadDatabaseTypes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete database type');
    }
  };

  const handleResetDefaults = async (typeId: string, typeName: string) => {
    if (!confirm(`Reset "${typeName}" to plugin defaults? Any customizations will be lost.`)) return;
    try {
      await resetDatabaseTypeDefaults(typeId);
      toast.success('Database type reset to defaults');
      loadDatabaseTypes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset database type');
    }
  };

  const handleExportJson = async (typeId: string) => {
    try {
      const result = await exportDatabaseTypeJson(typeId);
      if (result.written) {
        toast.success('Database type exported as JSON');
      } else {
        toast.error(result.error || 'Failed to export database type');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to export database type');
    }
  };

  const openCommandModal = (typeId: string, command?: DatabaseTypeCommand) => {
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
        await updateDatabaseTypeCommand(commandTypeId, editingCommand.id, {
          displayName: commandForm.displayName,
          command: commandForm.command,
          description: commandForm.description || undefined,
        });
        toast.success('Command updated');
      } else {
        await addDatabaseTypeCommand(commandTypeId, commandForm);
        toast.success('Command added');
      }
      setShowCommandModal(false);
      loadDatabaseTypes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save command');
    } finally {
      setSavingCommand(false);
    }
  };

  const handleDeleteCommand = async (typeId: string, commandId: string, commandName: string) => {
    if (!confirm(`Delete command "${commandName}"?`)) return;
    try {
      await deleteDatabaseTypeCommand(typeId, commandId);
      toast.success('Command deleted');
      loadDatabaseTypes();
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
          Configure database types with connection fields, backup commands, and predefined operations
        </p>
        {isAdmin(user) && (
          <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
            Add Database Type
          </button>
        )}
      </div>

      {databaseTypes.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-slate-400 mb-4">No database types configured</p>
          {isAdmin(user) && (
            <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
              Add Database Type
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {databaseTypes.map((type) => {
            const connectionFields = parseConnectionFields(type.connectionFields);
            return (
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
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium text-white">{type.displayName}</h3>
                        <span className="badge bg-slate-700 text-slate-300 text-xs">{type.source}</span>
                        {type.isCustomized && (
                          <span className="badge bg-yellow-500/20 text-yellow-400 text-xs">customized</span>
                        )}
                      </div>
                      <p className="text-sm text-slate-400">
                        {connectionFields.length} field{connectionFields.length !== 1 ? 's' : ''} |{' '}
                        {type.commands.length} command{type.commands.length !== 1 ? 's' : ''} |{' '}
                        {type._count?.databases || 0} database{(type._count?.databases || 0) !== 1 ? 's' : ''}
                        {type.defaultPort != null && <> | port {type.defaultPort}</>}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => handleExportJson(type.id)}
                      className="btn btn-ghost text-sm"
                    >
                      Export as JSON
                    </button>
                    {isAdmin(user) && (
                      <>
                        {type.source === 'plugin' && type.isCustomized && (
                          <button
                            onClick={() => handleResetDefaults(type.id, type.displayName)}
                            className="btn btn-ghost text-sm"
                          >
                            Reset to Defaults
                          </button>
                        )}
                        <button
                          onClick={() => openCommandModal(type.id)}
                          className="btn btn-ghost text-sm"
                        >
                          Add Command
                        </button>
                        {(type._count?.databases || 0) === 0 && (
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
                    {/* Connection Fields Section */}
                    <div className="mb-6">
                      <h4 className="text-sm font-medium text-slate-300 mb-3">Connection Fields</h4>
                      {connectionFields.length === 0 ? (
                        <p className="text-slate-500 text-sm">No connection fields configured</p>
                      ) : (
                        <div className="space-y-2">
                          {connectionFields.map((field, idx) => (
                            <div
                              key={idx}
                              className="flex items-center justify-between p-3 bg-slate-800 rounded-lg"
                            >
                              <div className="flex items-center gap-4">
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-white">{field.label}</span>
                                    <code className="text-xs bg-slate-700 px-2 py-0.5 rounded text-slate-300">
                                      {field.name}
                                    </code>
                                    <span className="text-xs bg-slate-700 px-2 py-0.5 rounded text-slate-300">
                                      {field.type}
                                    </span>
                                    {field.required && (
                                      <span className="text-xs bg-red-500/20 px-2 py-0.5 rounded text-red-400">
                                        required
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Backup & Restore Commands */}
                    {(type.backupCommand || type.restoreCommand) && (
                      <div className="mb-6">
                        <h4 className="text-sm font-medium text-slate-300 mb-3">Backup & Restore Templates</h4>
                        <div className="space-y-2">
                          {type.backupCommand && (
                            <div className="p-3 bg-slate-800 rounded-lg">
                              <span className="text-xs text-slate-400 block mb-1">Backup Command</span>
                              <code className="text-sm text-primary-400 font-mono whitespace-pre-wrap">
                                {type.backupCommand}
                              </code>
                            </div>
                          )}
                          {type.restoreCommand && (
                            <div className="p-3 bg-slate-800 rounded-lg">
                              <span className="text-xs text-slate-400 block mb-1">Restore Command</span>
                              <code className="text-sm text-primary-400 font-mono whitespace-pre-wrap">
                                {type.restoreCommand}
                              </code>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Commands Section */}
                    <div>
                      <h4 className="text-sm font-medium text-slate-300 mb-3">Commands</h4>
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
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create Type Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md p-5 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-white mb-4">Create Database Type</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Name (lowercase, no spaces)</label>
                <input
                  type="text"
                  value={newTypeName}
                  onChange={(e) => setNewTypeName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder="e.g., postgresql, mysql, redis"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Display Name</label>
                <input
                  type="text"
                  value={newTypeDisplayName}
                  onChange={(e) => setNewTypeDisplayName(e.target.value)}
                  placeholder="e.g., PostgreSQL, MySQL, Redis"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Default Port</label>
                <input
                  type="number"
                  value={newTypeDefaultPort}
                  onChange={(e) => setNewTypeDefaultPort(e.target.value)}
                  placeholder="e.g., 5432"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Connection Fields (JSON array)</label>
                <textarea
                  value={newTypeConnectionFields}
                  onChange={(e) => setNewTypeConnectionFields(e.target.value)}
                  placeholder={'[\n  { "name": "host", "label": "Host", "type": "text", "required": true },\n  { "name": "password", "label": "Password", "type": "password", "required": true }\n]'}
                  className="input font-mono text-sm"
                  rows={5}
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Backup Command (optional)</label>
                <textarea
                  value={newTypeBackupCommand}
                  onChange={(e) => setNewTypeBackupCommand(e.target.value)}
                  placeholder="e.g., pg_dump -h {{host}} -p {{port}} -U {{user}} {{database}}"
                  className="input font-mono text-sm"
                  rows={3}
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Restore Command (optional)</label>
                <textarea
                  value={newTypeRestoreCommand}
                  onChange={(e) => setNewTypeRestoreCommand(e.target.value)}
                  placeholder="e.g., psql -h {{host}} -p {{port}} -U {{user}} {{database}} < {{file}}"
                  className="input font-mono text-sm"
                  rows={3}
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
                  placeholder="e.g., shell, dump, restore"
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
                  placeholder="e.g., Database Shell, Dump Database"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Command</label>
                <input
                  type="text"
                  value={commandForm.command}
                  onChange={(e) => setCommandForm({ ...commandForm, command: e.target.value })}
                  placeholder="e.g., psql -U postgres"
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
