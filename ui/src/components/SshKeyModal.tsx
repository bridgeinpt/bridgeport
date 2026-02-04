import { useState, useEffect } from 'react';
import { Modal } from './Modal';
import { Alert } from './Alert';
import { updateSshSettings, deleteSshKey, checkServerHealth } from '../lib/api';
import { useAppStore } from '../lib/store';

interface SshKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUpdate?: () => void;
  currentSshUser?: string;
  testServerId?: string;
}

export function SshKeyModal({
  isOpen,
  onClose,
  onUpdate,
  currentSshUser = 'root',
  testServerId,
}: SshKeyModalProps) {
  const { selectedEnvironment } = useAppStore();
  const selectedEnvironmentId = selectedEnvironment?.id;
  const [sshUser, setSshUser] = useState(currentSshUser);
  const [sshPrivateKey, setSshPrivateKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setSshUser(currentSshUser);
      setSshPrivateKey('');
      setError(null);
      setSuccess(null);
      setConfirmDelete(false);
    }
  }, [isOpen, currentSshUser]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironmentId) return;

    if (!sshPrivateKey.trim()) {
      setError('SSH private key is required');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      await updateSshSettings(selectedEnvironmentId, {
        sshPrivateKey: sshPrivateKey.trim(),
        sshUser: sshUser.trim() || 'root',
      });
      setSuccess('SSH settings updated successfully');
      setSshPrivateKey('');
      onUpdate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update SSH settings');
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!testServerId) {
      setError('No server available to test connection');
      return;
    }

    setTesting(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await checkServerHealth(testServerId);
      if (result.status === 'healthy') {
        setSuccess('SSH connection test successful');
      } else {
        setError(`SSH connection test failed: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to test SSH connection');
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedEnvironmentId) return;

    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }

    setDeleting(true);
    setError(null);
    setSuccess(null);

    try {
      await deleteSshKey(selectedEnvironmentId);
      setSuccess('SSH key removed');
      setConfirmDelete(false);
      onUpdate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete SSH key');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="SSH Configuration" size="lg">
      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      {success && (
        <Alert variant="success" className="mb-4">
          {success}
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">SSH Username</label>
          <input
            type="text"
            value={sshUser}
            onChange={(e) => setSshUser(e.target.value)}
            placeholder="root"
            className="input"
          />
          <p className="text-xs text-slate-400 mt-1">
            Username for SSH connections to servers in this environment
          </p>
        </div>

        <div>
          <label className="label">SSH Private Key</label>
          <textarea
            value={sshPrivateKey}
            onChange={(e) => setSshPrivateKey(e.target.value)}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
            className="input font-mono text-sm min-h-[200px] resize-y"
            rows={10}
          />
          <p className="text-xs text-slate-400 mt-1">
            Paste the full private key content. The key is encrypted before storage.
          </p>
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex gap-2">
            {testServerId && (
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testing || saving}
                className="btn btn-secondary"
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
            )}
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || saving}
              className={`btn ${confirmDelete ? 'btn-danger' : 'btn-ghost text-red-400 hover:text-red-300'}`}
            >
              {deleting ? 'Removing...' : confirmDelete ? 'Confirm Remove' : 'Remove Key'}
            </button>
          </div>

          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={saving || !sshPrivateKey.trim()} className="btn btn-primary">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export default SshKeyModal;
