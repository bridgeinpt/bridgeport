import { useEffect, useState } from 'react';
import { Check, RefreshCw, Settings } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import { DataPagination } from '@/components/ui/data-pagination';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

function formatTimeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
  return new Date(date).toLocaleDateString();
}

function getSeverityBorder(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'border-destructive';
    case 'warning':
      return 'border-warning';
    default:
      return 'border-primary';
  }
}

// Sentinel value for the "All environments" Select option — Radix Select
// disallows an empty-string value, so we map it to/from envFilter ('').
const ALL_ENVS = '__all__';

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
        <p className="text-muted-foreground">
          {total} notification{total !== 1 ? 's' : ''}
          {unreadCount > 0 && ` (${unreadCount} unread)`}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={loadNotifications} title="Refresh">
            <RefreshCw className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={openPreferences} title="Preferences">
            <Settings className="size-4" />
          </Button>
          {unreadCount > 0 && (
            <Button variant="secondary" onClick={handleMarkAllAsRead}>
              Mark all as read
            </Button>
          )}
        </div>
      </div>

      {/* Filters */}
      <Card className="mb-6 py-4">
        <div className="flex flex-wrap items-end gap-4 px-6">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground uppercase tracking-wide">
              Category
            </Label>
            <Select
              value={category}
              onValueChange={(v) => {
                setCategory(v as 'all' | 'user' | 'system');
                setPage(0);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground uppercase tracking-wide">
              Environment
            </Label>
            <Select
              value={envFilter || ALL_ENVS}
              onValueChange={(v) => {
                setEnvFilter(v === ALL_ENVS ? '' : v);
                setPage(0);
              }}
            >
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_ENVS}>All environments</SelectItem>
                {environments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    {env.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Checkbox
              id="unreadOnly"
              checked={unreadOnly}
              onCheckedChange={(checked) => {
                setUnreadOnly(checked === true);
                setPage(0);
              }}
            />
            <Label htmlFor="unreadOnly" className="text-sm">
              Unread only
            </Label>
          </div>
        </div>
      </Card>

      {/* Notification list */}
      <Card className="py-0 gap-0">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Loading...</div>
        ) : notifications.length === 0 ? (
          <div className="p-12">
            <EmptyState
              message="No notifications"
              description={
                category !== 'all' || unreadOnly || envFilter
                  ? 'Try adjusting your filters'
                  : undefined
              }
            />
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {notifications.map((notification) => {
                const isUnread = !notification.inAppReadAt;
                const severityBorder = getSeverityBorder(notification.type.severity);
                const env = environments.find((e) => e.id === notification.environmentId);

                return (
                  <li
                    key={notification.id}
                    className={cn('px-6 py-4', isUnread && 'bg-muted/40')}
                  >
                    <div className={cn('border-l-2 pl-4', severityBorder)}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3
                              className={cn(
                                'text-sm font-medium',
                                isUnread ? 'text-foreground' : 'text-muted-foreground'
                              )}
                            >
                              {notification.title}
                            </h3>
                            {notification.type.severity !== 'info' && (
                              <StatusBadge
                                kind="severity"
                                value={notification.type.severity}
                              />
                            )}
                            <Badge variant="neutral">{notification.type.category}</Badge>
                            {env && <Badge variant="neutral">{env.name}</Badge>}
                          </div>
                          <p className="text-sm text-muted-foreground mt-1">
                            {notification.message}
                          </p>
                          <p className="text-xs text-muted-foreground/70 mt-2">
                            {formatTimeAgo(notification.createdAt)}
                            {notification.inAppReadAt && (
                              <span className="ml-2">
                                · Read {formatTimeAgo(notification.inAppReadAt)}
                              </span>
                            )}
                          </p>
                        </div>
                        {isUnread && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleMarkAsRead(notification.id)}
                            title="Mark as read"
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

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-6 py-4">
                <DataPagination
                  currentPage={page}
                  totalPages={totalPages}
                  totalItems={total}
                  pageSize={pageSize}
                  onPageChange={setPage}
                />
              </div>
            )}
          </>
        )}
      </Card>

      {/* Preferences Modal */}
      <Dialog open={showPreferences} onOpenChange={setShowPreferences}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Notification Preferences</DialogTitle>
            <DialogDescription>
              Choose which notifications you want to receive and how.
            </DialogDescription>
          </DialogHeader>

          {prefsLoading ? (
            <div className="py-8 text-center text-muted-foreground">Loading...</div>
          ) : (
            <div className="space-y-4">
              {/* Group preferences by category */}
              {['user', 'system'].map((cat) => {
                const catPrefs = preferences.filter((p) => p.type.category === cat);
                if (catPrefs.length === 0) return null;

                return (
                  <div key={cat} className="mb-6">
                    <h4 className="text-sm font-medium text-foreground uppercase tracking-wide mb-3">
                      {cat === 'user' ? 'Account Notifications' : 'System Notifications'}
                    </h4>
                    <div className="space-y-2">
                      {catPrefs.map((pref) => (
                        <div
                          key={pref.typeId}
                          className="flex items-center justify-between p-3 bg-muted/40 rounded-lg"
                        >
                          <div>
                            <p className="text-sm font-medium text-foreground">{pref.type.name}</p>
                            <p className="text-xs text-muted-foreground">{pref.type.description}</p>
                          </div>
                          <div className="flex items-center gap-4">
                            <Label className="flex items-center gap-2">
                              <Checkbox
                                checked={pref.inAppEnabled}
                                onCheckedChange={(checked) =>
                                  handleTogglePreference(pref.typeId, 'inAppEnabled', checked === true)
                                }
                              />
                              <span className="text-xs text-muted-foreground">In-App</span>
                            </Label>
                            <Label className="flex items-center gap-2">
                              <Checkbox
                                checked={pref.emailEnabled}
                                onCheckedChange={(checked) =>
                                  handleTogglePreference(pref.typeId, 'emailEnabled', checked === true)
                                }
                              />
                              <span className="text-xs text-muted-foreground">Email</span>
                            </Label>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <DialogFooter>
            <Button onClick={() => setShowPreferences(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
