import { useState, useEffect } from 'react';
import { Modal } from './Modal';
import { Alert } from './Alert';
import { useAuthStore } from '../lib/store';
import { changeUserPassword, updateUser } from '../lib/api';

interface AccountModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AccountModal({ isOpen, onClose }: AccountModalProps) {
  const { user, setUser } = useAuthStore();
  const [accountTab, setAccountTab] = useState<'profile' | 'password'>('profile');
  const [editName, setEditName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setEditName(user?.name || '');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setError(null);
      setSuccess(null);
      setAccountTab('profile');
    }
  }, [isOpen, user?.name]);

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { user: updatedUser } = await updateUser(user.id, { name: editName || undefined });
      setUser({ ...user, name: updatedUser.name });
      setSuccess('Profile updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await changeUserPassword(user.id, {
        currentPassword,
        newPassword,
      });
      setSuccess('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setSaving(false);
    }
  };

  const handleTabChange = (tab: 'profile' | 'password') => {
    setAccountTab(tab);
    setError(null);
    setSuccess(null);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="My Account">
      {/* Tabs */}
      <div className="tabs mb-4">
        <button
          onClick={() => handleTabChange('profile')}
          className={`tab ${accountTab === 'profile' ? 'tab-active' : 'tab-inactive'}`}
        >
          Profile
        </button>
        <button
          onClick={() => handleTabChange('password')}
          className={`tab ${accountTab === 'password' ? 'tab-active' : 'tab-inactive'}`}
        >
          Change Password
        </button>
      </div>

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

      {accountTab === 'profile' && (
        <form onSubmit={handleUpdateProfile} className="space-y-4">
          <div>
            <label className="label">Email</label>
            <input
              type="email"
              value={user?.email || ''}
              className="input bg-slate-800"
              disabled
            />
          </div>
          <div>
            <label className="label">Name</label>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Your name"
              className="input"
            />
          </div>
          <div>
            <label className="label">Role</label>
            <input
              type="text"
              value={user?.role || ''}
              className="input bg-slate-800 capitalize"
              disabled
            />
          </div>
          <div className="flex justify-end pt-2">
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      )}

      {accountTab === 'password' && (
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div>
            <label className="label">Current Password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="input"
              required
            />
          </div>
          <div>
            <label className="label">New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Minimum 8 characters"
              minLength={8}
              className="input"
              required
            />
          </div>
          <div>
            <label className="label">Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="input"
              required
            />
          </div>
          <div className="flex justify-end pt-2">
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? 'Changing...' : 'Change Password'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default AccountModal;
