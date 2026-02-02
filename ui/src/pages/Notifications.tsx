import { useEffect, useState } from 'react';
import {
  listNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  listEnvironments,
  getNotificationPreferences,
  updateNotificationPreference,
  type NotificationWithType,
  type Environment,
  type NotificationPreference,
} from '../lib/api';
import { useToast } from '../components/Toast';
import { CheckIcon, RefreshIcon, SettingsIcon } from '../components/Icons';

function formatTimeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
  return new Date(date).toLocaleDateString();
}

function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'border-red-500';
    case 'warning':
      return 'border-yellow-500';
    default:
      return 'border-primary-500';
  }
}

function getSeverityBadge(severity: string): { bg: string; text: string } {
  switch (severity) {
    case 'critical':
      return { bg: 'bg-red-500/20', text: 'text-red-400' };
    case 'warning':
      return { bg: 'bg-yellow-500/20', text: 'text-yellow-400' };
    default:
      return { bg: 'bg-primary-500/20', text: 'text-primary-400' };
  }
}

export default function Notifications() {
  const toast = useToast();

  const [notifications, setNotifications] = useState<NotificationWithType[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [environments, setEnvironments] = useState<Environment[]>([]);

  // Filters
  const [category, setCategory] = useState<'all' | 'user' | 'system'>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [envFilter, setEnvFilter] = useState<string>('');
  const [page, setPage] = useState(0);
  const pageSize = 25;

  // Preferences modal
  const [showPreferences, setShowPreferences] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [prefsLoading, setPrefsLoading] = useState(false);

  useEffect(() => {
    listEnvironments().then(({ environments }) => setEnvironments(environments));
  }, []);

  useEffect(() => {
    loadNotifications();
  }, [category, unreadOnly, envFilter, page]);

  const loadNotifications = async () => {
    setLoading(true);
    try {
      const { notifications: notifs, total: t } = await listNotifications({
        limit: pageSize,
        offset: page * pageSize,
        unreadOnly,
        environmentId: envFilter || undefined,
        category: category === 'all' ? undefined : category,
      });
      setNotifications(notifs);
      setTotal(t);
    } catch (error) {
      toast.error('Failed to load notifications');
    } finally {
      setLoading(false);
    }
  };

  const handleMarkAsRead = async (id: string) => {
    try {
      await markNotificationAsRead(id);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, inAppReadAt: new Date().toISOString() } : n))
      );
      toast.success('Marked as read');
    } catch (error) {
      toast.error('Failed to mark as read');
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      const { count } = await markAllNotificationsAsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, inAppReadAt: new Date().toISOString() })));
      toast.success(`Marked ${count} notifications as read`);
    } catch (error) {
      toast.error('Failed to mark all as read');
    }
  };

  const loadPreferences = async () => {
    setPrefsLoading(true);
    try {
      const { preferences: prefs } = await getNotificationPreferences();
      setPreferences(prefs);
    } catch (error) {
      toast.error('Failed to load preferences');
    } finally {
      setPrefsLoading(false);
    }
  };

  const handleTogglePreference = async (
    typeId: string,
    field: 'inAppEnabled' | 'emailEnabled',
    value: boolean
  ) => {
    try {
      await updateNotificationPreference(typeId, { [field]: value });
      setPreferences((prev) =>
        prev.map((p) => (p.typeId === typeId ? { ...p, [field]: value } : p))
      );
    } catch (error) {
      toast.error('Failed to update preference');
    }
  };

  const openPreferences = () => {
    loadPreferences();
    setShowPreferences(true);
  };

  const totalPages = Math.ceil(total / pageSize);
  const unreadCount = notifications.filter((n) => !n.inAppReadAt).length;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          {total} notification{total !== 1 ? 's' : ''}
          {unreadCount > 0 && ` (${unreadCount} unread)`}
        </p>
        <div className="flex items-center gap-2">
          <button onClick={loadNotifications} className="btn btn-ghost" title="Refresh">
            <RefreshIcon className="w-4 h-4" />
          </button>
          <button onClick={openPreferences} className="btn btn-ghost" title="Preferences">
            <SettingsIcon className="w-4 h-4" />
          </button>
          {unreadCount > 0 && (
            <button onClick={handleMarkAllAsRead} className="btn btn-secondary">
              Mark all as read
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="card mb-6">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-wide block mb-1">
              Category
            </label>
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value as 'all' | 'user' | 'system');
                setPage(0);
              }}
              className="input py-2"
            >
              <option value="all">All</option>
              <option value="user">User</option>
              <option value="system">System</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-wide block mb-1">
              Environment
            </label>
            <select
              value={envFilter}
              onChange={(e) => {
                setEnvFilter(e.target.value);
                setPage(0);
              }}
              className="input py-2"
            >
              <option value="">All environments</option>
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 pt-5">
            <input
              type="checkbox"
              id="unreadOnly"
              checked={unreadOnly}
              onChange={(e) => {
                setUnreadOnly(e.target.checked);
                setPage(0);
              }}
              className="rounded bg-slate-800 border-slate-600 text-primary-500 focus:ring-primary-500"
            />
            <label htmlFor="unreadOnly" className="text-sm text-slate-300">
              Unread only
            </label>
          </div>
        </div>
      </div>

      {/* Notification list */}
      <div className="card">
        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading...</div>
        ) : notifications.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-slate-400">No notifications</p>
            {(category !== 'all' || unreadOnly || envFilter) && (
              <p className="text-slate-500 text-sm mt-2">Try adjusting your filters</p>
            )}
          </div>
        ) : (
          <>
            <ul className="divide-y divide-slate-700">
              {notifications.map((notification) => {
                const isUnread = !notification.inAppReadAt;
                const severityColor = getSeverityColor(notification.type.severity);
                const badge = getSeverityBadge(notification.type.severity);
                const env = environments.find((e) => e.id === notification.environmentId);

                return (
                  <li
                    key={notification.id}
                    className={`px-6 py-4 ${isUnread ? 'bg-slate-800/50' : ''}`}
                  >
                    <div className={`border-l-2 pl-4 ${severityColor}`}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className={`text-sm font-medium ${isUnread ? 'text-white' : 'text-slate-300'}`}>
                              {notification.title}
                            </h3>
                            {notification.type.severity !== 'info' && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.bg} ${badge.text}`}>
                                {notification.type.severity}
                              </span>
                            )}
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
                              {notification.type.category}
                            </span>
                            {env && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
                                {env.name}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-slate-400 mt-1">{notification.message}</p>
                          <p className="text-xs text-slate-500 mt-2">
                            {formatTimeAgo(notification.createdAt)}
                            {notification.inAppReadAt && (
                              <span className="ml-2">
                                · Read {formatTimeAgo(notification.inAppReadAt)}
                              </span>
                            )}
                          </p>
                        </div>
                        {isUnread && (
                          <button
                            onClick={() => handleMarkAsRead(notification.id)}
                            className="btn btn-ghost text-xs"
                            title="Mark as read"
                          >
                            <CheckIcon className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-6 py-4 border-t border-slate-700 flex items-center justify-between">
                <p className="text-sm text-slate-400">
                  Showing {page * pageSize + 1}-{Math.min((page + 1) * pageSize, total)} of {total}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage(Math.max(0, page - 1))}
                    disabled={page === 0}
                    className="btn btn-ghost text-sm disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="text-sm text-slate-400">
                    Page {page + 1} of {totalPages}
                  </span>
                  <button
                    onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                    disabled={page >= totalPages - 1}
                    className="btn btn-ghost text-sm disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Preferences Modal */}
      {showPreferences && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-2xl p-6 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Notification Preferences</h3>
              <button
                onClick={() => setShowPreferences(false)}
                className="text-slate-400 hover:text-white"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {prefsLoading ? (
              <div className="py-8 text-center text-slate-400">Loading...</div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-slate-400 mb-4">
                  Choose which notifications you want to receive and how.
                </p>

                {/* Group preferences by category */}
                {['user', 'system'].map((cat) => {
                  const catPrefs = preferences.filter((p) => p.type.category === cat);
                  if (catPrefs.length === 0) return null;

                  return (
                    <div key={cat} className="mb-6">
                      <h4 className="text-sm font-medium text-white uppercase tracking-wide mb-3">
                        {cat === 'user' ? 'Account Notifications' : 'System Notifications'}
                      </h4>
                      <div className="space-y-2">
                        {catPrefs.map((pref) => (
                          <div
                            key={pref.typeId}
                            className="flex items-center justify-between p-3 bg-slate-800 rounded-lg"
                          >
                            <div>
                              <p className="text-sm font-medium text-white">{pref.type.name}</p>
                              <p className="text-xs text-slate-400">{pref.type.description}</p>
                            </div>
                            <div className="flex items-center gap-4">
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={pref.inAppEnabled}
                                  onChange={(e) =>
                                    handleTogglePreference(pref.typeId, 'inAppEnabled', e.target.checked)
                                  }
                                  className="rounded bg-slate-700 border-slate-600 text-primary-500"
                                />
                                <span className="text-xs text-slate-300">In-App</span>
                              </label>
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={pref.emailEnabled}
                                  onChange={(e) =>
                                    handleTogglePreference(pref.typeId, 'emailEnabled', e.target.checked)
                                  }
                                  className="rounded bg-slate-700 border-slate-600 text-primary-500"
                                />
                                <span className="text-xs text-slate-300">Email</span>
                              </label>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-6 pt-4 border-t border-slate-700 flex justify-end">
              <button onClick={() => setShowPreferences(false)} className="btn btn-primary">
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
