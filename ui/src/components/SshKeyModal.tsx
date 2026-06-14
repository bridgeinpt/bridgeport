import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { updateSshSettings, deleteSshKey, checkServerHealth } from '../lib/api';
import { useAppStore } from '../lib/store';
import { getErrorMessage } from '@/lib/helpers';

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
      setError(getErrorMessage(err, 'Failed to update SSH settings'));
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
      setError(getErrorMessage(err, 'Failed to test SSH connection'));
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
      setError(getErrorMessage(err, 'Failed to delete SSH key'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>SSH Configuration</DialogTitle>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert variant="success">
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ssh-user">SSH Username</Label>
            <Input
              id="ssh-user"
              type="text"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              placeholder="root"
            />
            <p className="text-xs text-muted-foreground">
              Username for SSH connections to servers in this environment
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ssh-private-key">SSH Private Key</Label>
            <Textarea
              id="ssh-private-key"
              value={sshPrivateKey}
              onChange={(e) => setSshPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
              className="font-mono text-sm min-h-[200px] resize-y"
              rows={10}
            />
            <p className="text-xs text-muted-foreground">
              Paste the full private key content. The key is encrypted before storage.
            </p>
          </div>

          <div className="flex items-center justify-between pt-2">
            <div className="flex gap-2">
              {testServerId && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleTestConnection}
                  disabled={testing || saving}
                >
                  {testing ? 'Testing...' : 'Test Connection'}
                </Button>
              )}
              <Button
                type="button"
                variant={confirmDelete ? 'destructive' : 'ghost'}
                onClick={handleDelete}
                disabled={deleting || saving}
                className={confirmDelete ? undefined : 'text-destructive hover:text-destructive'}
              >
                {deleting ? 'Removing...' : confirmDelete ? 'Confirm Remove' : 'Remove Key'}
              </Button>
            </div>

            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !sshPrivateKey.trim()}>
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default SshKeyModal;
