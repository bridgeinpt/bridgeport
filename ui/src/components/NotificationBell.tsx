import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { BellIcon, CheckIcon } from './Icons';
import {
  getNotificationsUnreadCount,
  listNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  type NotificationWithType,
} from '../lib/api';

function formatTimeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
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

export default function NotificationBell() {
  const [isOpen, setIsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<NotificationWithType[]>([]);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch unread count on mount and periodically
  useEffect(() => {
    const fetchUnreadCount = async () => {
      try {
        const { count } = await getNotificationsUnreadCount();
        setUnreadCount(count);
      } catch (error) {
        console.error('Failed to fetch unread count:', error);
      }
    };

    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000); // Refresh every 30 seconds
    return () => clearInterval(interval);
  }, []);

  // Fetch notifications when dropdown opens
  useEffect(() => {
    if (isOpen) {
      loadNotifications();
    }
  }, [isOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadNotifications = async () => {
    setLoading(true);
    try {
      const { notifications: notifs } = await listNotifications({ limit: 10 });
      setNotifications(notifs);
    } catch (error) {
      console.error('Failed to load notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleMarkAsRead = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await markNotificationAsRead(id);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, inAppReadAt: new Date().toISOString() } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      await markAllNotificationsAsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, inAppReadAt: new Date().toISOString() })));
      setUnreadCount(0);
    } catch (error) {
      console.error('Failed to mark all notifications as read:', error);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative text-slate-400 hover:text-white p-1"
        title="Notifications"
        aria-label="Notifications"
      >
        <BellIcon className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 bg-slate-800 border border-slate-700 rounded-lg shadow-lg z-50">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
            <h3 className="text-sm font-semibold text-white">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllAsRead}
                className="text-xs text-primary-400 hover:text-primary-300"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-slate-400 text-sm">Loading...</div>
            ) : notifications.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">No notifications</div>
            ) : (
              <ul>
                {notifications.map((notification) => {
                  const isUnread = !notification.inAppReadAt;
                  const severityColor = getSeverityColor(notification.type.severity);
                  const badge = getSeverityBadge(notification.type.severity);

                  return (
                    <li
                      key={notification.id}
                      className={`px-4 py-3 border-b border-slate-700/50 last:border-0 hover:bg-slate-750 ${
                        isUnread ? 'bg-slate-800/80' : 'bg-transparent'
                      }`}
                    >
                      <div className={`border-l-2 pl-3 ${severityColor}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className={`text-sm font-medium ${isUnread ? 'text-white' : 'text-slate-300'}`}>
                                {notification.title}
                              </p>
                              {notification.type.severity !== 'info' && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.bg} ${badge.text}`}>
                                  {notification.type.severity}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{notification.message}</p>
                            <p className="text-[10px] text-slate-500 mt-1">
                              {formatTimeAgo(notification.createdAt)}
                            </p>
                          </div>
                          {isUnread && (
                            <button
                              onClick={(e) => handleMarkAsRead(notification.id, e)}
                              className="text-slate-400 hover:text-white p-1 flex-shrink-0"
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
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-slate-700">
            <Link
              to="/notifications"
              onClick={() => setIsOpen(false)}
              className="block text-center text-xs text-primary-400 hover:text-primary-300"
            >
              View all notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
