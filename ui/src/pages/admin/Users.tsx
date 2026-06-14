import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuthStore, isAdmin } from '../../lib/store';
import {
  listUsers,
  getActiveUsers,
  createUser,
  updateUser,
  deleteUser,
  changeUserPassword,
  type User,
  type UserRole,
} from '../../lib/api';
import { formatDistanceToNow } from 'date-fns';
import { Pencil, Trash2, KeyRound } from 'lucide-react';
import { getErrorMessage } from '@/lib/helpers';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TableSkeleton } from '@/components/ui/table-skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

const roleLabels: Record<UserRole, string> = {
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
};

// Preserve the legacy color intent: admin=purple/brand, operator=blue, viewer=neutral.
const roleBadgeVariant: Record<UserRole, 'default' | 'info' | 'neutral'> = {
  admin: 'default',
  operator: 'info',
  viewer: 'neutral',
};

const roleSelectItems: { value: UserRole; label: string }[] = [
  { value: 'viewer', label: 'Viewer - Read-only access' },
  { value: 'operator', label: 'Operator - Can deploy and manage services' },
  { value: 'admin', label: 'Admin - Full access' },
];

const createSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().max(120).optional(),
  role: z.enum(['admin', 'operator', 'viewer']),
});
type CreateValues = z.infer<typeof createSchema>;

const editSchema = z.object({
  name: z.string().max(120).optional(),
  role: z.enum(['admin', 'operator', 'viewer']),
});
type EditValues = z.infer<typeof editSchema>;

const passwordSchema = z.object({
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});
type PasswordValues = z.infer<typeof passwordSchema>;

export default function Users() {
  const { user: currentUser } = useAuthStore();
  const confirm = useConfirm();
  const [users, setUsers] = useState<User[]>([]);
  const [activeUserIds, setActiveUserIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create user modal
  const [showCreate, setShowCreate] = useState(false);

  // Edit user modal
  const [editingUser, setEditingUser] = useState<User | null>(null);

  // Change password modal
  const [passwordUser, setPasswordUser] = useState<User | null>(null);

  const createForm = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { email: '', password: '', name: '', role: 'viewer' },
  });
  const editForm = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: '', role: 'viewer' },
  });
  const passwordForm = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { newPassword: '' },
  });

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const [usersRes, activeRes] = await Promise.all([
        listUsers(),
        getActiveUsers(),
      ]);
      setUsers(usersRes.users);
      setActiveUserIds(new Set(activeRes.activeUsers.map((u) => u.id)));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load users'));
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    createForm.reset({ email: '', password: '', name: '', role: 'viewer' });
    setError(null);
    setShowCreate(true);
  };

  const handleCreate = async (values: CreateValues) => {
    setError(null);
    try {
      const { user } = await createUser({
        email: values.email,
        password: values.password,
        name: values.name || undefined,
        role: values.role,
      });
      setUsers((prev) => [user, ...prev]);
      setShowCreate(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to create user'));
    }
  };

  const openEditModal = (user: User) => {
    setEditingUser(user);
    editForm.reset({ name: user.name || '', role: user.role });
    setError(null);
  };

  const handleEdit = async (values: EditValues) => {
    if (!editingUser) return;
    setError(null);
    try {
      const { user } = await updateUser(editingUser.id, {
        name: values.name || undefined,
        role: values.role,
      });
      setUsers((prev) => prev.map((u) => (u.id === user.id ? user : u)));
      setEditingUser(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to update user'));
    }
  };

  const handleDelete = async (user: User) => {
    const ok = await confirm({
      title: 'Delete user',
      description: `Are you sure you want to delete ${user.email}?`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;

    setError(null);
    try {
      await deleteUser(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete user'));
    }
  };

  const openPasswordModal = (user: User) => {
    setPasswordUser(user);
    passwordForm.reset({ newPassword: '' });
    setError(null);
  };

  const handleChangePassword = async (values: PasswordValues) => {
    if (!passwordUser) return;
    setError(null);
    try {
      await changeUserPassword(passwordUser.id, {
        newPassword: values.newPassword,
      });
      setPasswordUser(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to change password'));
    }
  };

  if (!isAdmin(currentUser)) {
    return (
      <div className="p-6">
        <Card className="py-12 text-center">
          <p className="text-destructive">Access denied. Admin privileges required.</p>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6">
        <TableSkeleton rows={3} columns={4} />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-5 flex items-center justify-end">
        <Button onClick={openCreate}>Add User</Button>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Create User Modal */}
      <Dialog open={showCreate} onOpenChange={(open) => !open && setShowCreate(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
          </DialogHeader>
          <Form {...createForm}>
            <form onSubmit={createForm.handleSubmit(handleCreate)} className="space-y-4">
              <FormField
                control={createForm.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="user@example.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={createForm.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="Minimum 8 characters" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={createForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="John Doe" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={createForm.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {roleSelectItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createForm.formState.isSubmitting}>
                  {createForm.formState.isSubmitting ? 'Creating...' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Edit User Modal */}
      <Dialog open={editingUser !== null} onOpenChange={(open) => !open && setEditingUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(handleEdit)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-user-email">Email</Label>
                <Input id="edit-user-email" type="email" value={editingUser?.email ?? ''} disabled />
              </div>
              <FormField
                control={editForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="John Doe" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={editingUser?.id === currentUser?.id}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {roleSelectItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {editingUser?.id === currentUser?.id && (
                      <p className="text-xs text-muted-foreground">You cannot change your own role</p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setEditingUser(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={editForm.formState.isSubmitting}>
                  {editForm.formState.isSubmitting ? 'Saving...' : 'Save'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Change Password Modal */}
      <Dialog open={passwordUser !== null} onOpenChange={(open) => !open && setPasswordUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change Password</DialogTitle>
            <DialogDescription>Set a new password for {passwordUser?.email}</DialogDescription>
          </DialogHeader>
          <Form {...passwordForm}>
            <form onSubmit={passwordForm.handleSubmit(handleChangePassword)} className="space-y-4">
              <FormField
                control={passwordForm.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="Minimum 8 characters" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setPasswordUser(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={passwordForm.formState.isSubmitting}>
                  {passwordForm.formState.isSubmitting ? 'Changing...' : 'Change Password'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Active Users Summary */}
      {activeUserIds.size > 0 && (
        <Card className="mb-6 p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="size-2 animate-pulse rounded-full bg-success" />
            <h3 className="text-sm font-medium text-foreground">
              {activeUserIds.size} Active User{activeUserIds.size !== 1 ? 's' : ''}
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {users
              .filter((u) => activeUserIds.has(u.id))
              .map((u) => (
                <Badge key={u.id} variant="secondary">
                  {u.name || u.email}
                </Badge>
              ))}
          </div>
        </Card>
      )}

      {/* Users Table */}
      {users.length === 0 ? (
        <EmptyState message="No users found" />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar>
                        <AvatarFallback>
                          {user.name?.[0]?.toUpperCase() || user.email[0].toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">
                            {user.name || user.email}
                          </span>
                          {activeUserIds.has(user.id) && (
                            <Badge variant="success" className="gap-1">
                              <span className="size-1.5 animate-pulse rounded-full bg-current" />
                              Online
                            </Badge>
                          )}
                          {user.id === currentUser?.id && (
                            <Badge variant="info">You</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">{user.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={roleBadgeVariant[user.role]}>{roleLabels[user.role]}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {user.createdAt
                      ? formatDistanceToNow(new Date(user.createdAt), { addSuffix: true })
                      : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditModal(user)}
                        title="Edit"
                        aria-label="Edit"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openPasswordModal(user)}
                        title="Change Password"
                        aria-label="Change Password"
                      >
                        <KeyRound className="size-4" />
                      </Button>
                      {user.id !== currentUser?.id && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(user)}
                          title="Delete"
                          aria-label="Delete"
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
