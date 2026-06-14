import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ChevronRight, Pencil, Trash2, Layers } from 'lucide-react';
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
import { getErrorMessage } from '@/lib/helpers';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

const typeSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  displayName: z.string().min(1, 'Display name is required'),
});
type TypeValues = z.infer<typeof typeSchema>;

const commandSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  displayName: z.string().min(1, 'Display name is required'),
  command: z.string().min(1, 'Command is required'),
  description: z.string().optional(),
});
type CommandValues = z.infer<typeof commandSchema>;

export default function ServiceTypes() {
  const { user } = useAuthStore();
  const toast = useToast();
  const confirm = useConfirm();
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedType, setExpandedType] = useState<string | null>(null);

  // Create type modal
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Create/edit command modal
  const [showCommandModal, setShowCommandModal] = useState(false);
  const [editingCommand, setEditingCommand] = useState<ServiceTypeCommand | null>(null);
  const [commandTypeId, setCommandTypeId] = useState<string | null>(null);

  const typeForm = useForm<TypeValues>({
    resolver: zodResolver(typeSchema),
    defaultValues: { name: '', displayName: '' },
  });

  const commandForm = useForm<CommandValues>({
    resolver: zodResolver(commandSchema),
    defaultValues: { name: '', displayName: '', command: '', description: '' },
  });

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

  const openCreateModal = () => {
    typeForm.reset({ name: '', displayName: '' });
    setShowCreateModal(true);
  };

  const handleCreateType = async (values: TypeValues) => {
    try {
      await createServiceType({ name: values.name, displayName: values.displayName });
      toast.success('Service type created');
      setShowCreateModal(false);
      loadServiceTypes();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create service type'));
    }
  };

  const handleDeleteType = async (typeId: string, typeName: string) => {
    const ok = await confirm({
      title: 'Delete service type',
      description: `Delete service type "${typeName}"? This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteServiceType(typeId);
      toast.success('Service type deleted');
      loadServiceTypes();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete service type'));
    }
  };

  const openCommandModal = (typeId: string, command?: ServiceTypeCommand) => {
    setCommandTypeId(typeId);
    setEditingCommand(command || null);
    commandForm.reset({
      name: command?.name || '',
      displayName: command?.displayName || '',
      command: command?.command || '',
      description: command?.description || '',
    });
    setShowCommandModal(true);
  };

  const handleSaveCommand = async (values: CommandValues) => {
    if (!commandTypeId) return;
    try {
      if (editingCommand) {
        await updateServiceTypeCommand(commandTypeId, editingCommand.id, {
          displayName: values.displayName,
          command: values.command,
          description: values.description || undefined,
        });
        toast.success('Command updated');
      } else {
        await addServiceTypeCommand(commandTypeId, {
          name: values.name,
          displayName: values.displayName,
          command: values.command,
          description: values.description || undefined,
        });
        toast.success('Command added');
      }
      setShowCommandModal(false);
      loadServiceTypes();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save command'));
    }
  };

  const handleDeleteCommand = async (typeId: string, commandId: string, commandName: string) => {
    const ok = await confirm({
      title: 'Delete command',
      description: `Delete command "${commandName}"?`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteServiceTypeCommand(typeId, commandId);
      toast.success('Command deleted');
      loadServiceTypes();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete command'));
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Service Types"
        actions={
          isAdmin(user) ? (
            <Button onClick={openCreateModal}>Add Service Type</Button>
          ) : undefined
        }
      />

      {serviceTypes.length === 0 ? (
        <EmptyState
          icon={Layers}
          message="No service types configured"
          action={
            isAdmin(user)
              ? { label: 'Add Service Type', onClick: openCreateModal }
              : undefined
          }
        />
      ) : (
        <div className="space-y-4">
          {serviceTypes.map((type) => (
            <Card key={type.id} className="gap-0 p-4">
              <div
                className="flex cursor-pointer items-center justify-between"
                onClick={() => setExpandedType(expandedType === type.id ? null : type.id)}
              >
                <div className="flex items-center gap-3">
                  <ChevronRight
                    className={`size-5 text-muted-foreground transition-transform ${
                      expandedType === type.id ? 'rotate-90' : ''
                    }`}
                  />
                  <div>
                    <h3 className="font-medium text-foreground">{type.displayName}</h3>
                    <p className="text-sm text-muted-foreground">
                      {type.commands.length} command{type.commands.length !== 1 ? 's' : ''} |{' '}
                      {type._count?.services || 0} service{(type._count?.services || 0) !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  {isAdmin(user) && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => openCommandModal(type.id)}>
                        Add Command
                      </Button>
                      {(type._count?.services || 0) === 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleDeleteType(type.id, type.name)}
                        >
                          Delete
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {expandedType === type.id && (
                <div className="mt-4 border-t pt-4">
                  {type.commands.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No commands configured</p>
                  ) : (
                    <div className="space-y-2">
                      {type.commands.map((cmd) => (
                        <div
                          key={cmd.id}
                          className="flex items-center justify-between rounded-lg bg-muted/50 p-3"
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-foreground">{cmd.displayName}</span>
                              <Badge variant="neutral" className="rounded font-mono">
                                {cmd.name}
                              </Badge>
                            </div>
                            <code className="text-sm text-primary">{cmd.command}</code>
                            {cmd.description && (
                              <p className="mt-1 text-sm text-muted-foreground">{cmd.description}</p>
                            )}
                          </div>
                          {isAdmin(user) && (
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Edit command"
                                onClick={() => openCommandModal(type.id, cmd)}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Delete command"
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => handleDeleteCommand(type.id, cmd.id, cmd.name)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Create Type Modal */}
      <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Service Type</DialogTitle>
          </DialogHeader>
          <Form {...typeForm}>
            <form onSubmit={typeForm.handleSubmit(handleCreateType)} className="space-y-4">
              <FormField
                control={typeForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name (lowercase, no spaces)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g., django, nodejs, ruby"
                        {...field}
                        onChange={(e) =>
                          field.onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={typeForm.control}
                name="displayName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Django, Node.js, Ruby on Rails" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setShowCreateModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={typeForm.formState.isSubmitting}>
                  {typeForm.formState.isSubmitting ? 'Creating...' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Command Modal */}
      <Dialog open={showCommandModal} onOpenChange={setShowCommandModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCommand ? 'Edit Command' : 'Add Command'}</DialogTitle>
          </DialogHeader>
          <Form {...commandForm}>
            <form onSubmit={commandForm.handleSubmit(handleSaveCommand)} className="space-y-4">
              <FormField
                control={commandForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name (lowercase, no spaces)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g., shell, migrate"
                        disabled={!!editingCommand}
                        {...field}
                        onChange={(e) =>
                          field.onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={commandForm.control}
                name="displayName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Django Shell, Run Migrations" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={commandForm.control}
                name="command"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Command</FormLabel>
                    <FormControl>
                      <Input
                        className="font-mono"
                        placeholder="e.g., python manage.py shell"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={commandForm.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description (optional)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Brief description of what this command does"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setShowCommandModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={commandForm.formState.isSubmitting}>
                  {commandForm.formState.isSubmitting
                    ? 'Saving...'
                    : editingCommand
                    ? 'Update'
                    : 'Add'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
