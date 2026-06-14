import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/utils';
import {
  getNotificationsUnreadCount,
  listNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  type NotificationWithType,
} from '../lib/api';
import { useEventSource } from '../lib/useEventSource';

function formatTimeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(date).toLocaleDateString();
}

/** Left accent border by severity, bound to theme tokens. */
function severityBorder(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'border-destructive';
    case 'warning':
      return 'border-warning';
    default:
      return 'border-primary';
  }
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<NotificationWithType[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getNotificationsUnreadCount()
      .then(({ count }) => setUnreadCount(count))
      .catch((error) => console.error('Failed to fetch unread count:', error));
  }, []);

  const handleNotificationEvent = useCallback(() => {
    getNotificationsUnreadCount()
      .then(({ count }) => setUnreadCount(count))
      .catch(() => {});
  }, []);

  useEventSource('notification', handleNotificationEvent);

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const { notifications: notifs } = await listNotifications({ limit: 10 });
      setNotifications(notifs);
    } catch (error) {
      console.error('Failed to load notifications:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadNotifications();
  }, [open, loadNotifications]);

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          title="Notifications"
          aria-label="Notifications"
          aria-expanded={open}
        >
          <Bell className="size-5" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <button
              onClick={handleMarkAllAsRead}
              className="text-xs text-primary hover:text-primary/80"
            >
              Mark all read
            </button>
          )}
        </div>

        <ScrollArea className="max-h-96">
          <div aria-live="polite">
            {loading ? (
              <div className="p-4 text-center text-sm text-muted-foreground">Loading...</div>
            ) : notifications.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No notifications</div>
            ) : (
              <ul>
                {notifications.map((notification) => {
                  const isUnread = !notification.inAppReadAt;
                  return (
                    <li
                      key={notification.id}
                      className={cn(
                        'border-b px-4 py-3 last:border-0 hover:bg-accent',
                        isUnread && 'bg-accent/40'
                      )}
                    >
                      <div className={cn('border-l-2 pl-3', severityBorder(notification.type.severity))}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p
                                className={cn(
                                  'text-sm font-medium',
                                  isUnread ? 'text-foreground' : 'text-muted-foreground'
                                )}
                              >
                                {notification.title}
                              </p>
                              {notification.type.severity !== 'info' && (
                                <StatusBadge kind="severity" value={notification.type.severity} />
                              )}
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                              {notification.message}
                            </p>
                            <p className="mt-1 text-[10px] text-muted-foreground/70">
                              {formatTimeAgo(notification.createdAt)}
                            </p>
                          </div>
                          {isUnread && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={(e) => handleMarkAsRead(notification.id, e)}
                              className="shrink-0"
                              title="Mark as read"
                              aria-label="Mark as read"
                            >
                              <Check className="size-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </ScrollArea>

        <div className="border-t px-4 py-2">
          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="block text-center text-xs text-primary hover:text-primary/80"
          >
            View all notifications
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
