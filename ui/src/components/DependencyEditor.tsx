import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, X } from 'lucide-react';
import { toast } from './Toast';
import { useConfirm } from '@/hooks/useConfirm';
import { getErrorMessage } from '@/lib/helpers';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getServiceDependencies,
  addServiceDependency,
  removeServiceDependency,
  getAvailableDependencies,
  type ServiceDependency,
  type ServiceDependent,
  type DependencyType,
  type Service,
} from '../lib/api';

interface DependencyEditorProps {
  serviceId: string;
  serviceName?: string;
  onUpdate?: () => void;
}

const dependencyFormSchema = z.object({
  type: z.enum(['health_before', 'deploy_after']),
});

type DependencyFormValues = z.infer<typeof dependencyFormSchema>;

export function DependencyEditor({ serviceId, serviceName = 'This service', onUpdate }: DependencyEditorProps) {
  const confirm = useConfirm();
  const [dependencies, setDependencies] = useState<ServiceDependency[]>([]);
  const [dependents, setDependents] = useState<ServiceDependent[]>([]);
  const [available, setAvailable] = useState<
    (Omit<Service, 'serviceDeployments'> & {
      serviceDeployments: Array<{ server: { name: string } }>;
    })[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const form = useForm<DependencyFormValues>({
    resolver: zodResolver(dependencyFormSchema),
    defaultValues: { type: 'health_before' },
  });

  useEffect(() => {
    loadDependencies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId]);

  const loadDependencies = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [depsRes, availRes] = await Promise.all([
        getServiceDependencies(serviceId),
        getAvailableDependencies(serviceId),
      ]);
      setDependencies(depsRes.dependencies);
      setDependents(depsRes.dependents);
      setAvailable(availRes.services);
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to load dependencies');
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (dependsOnId: string) => {
    const addType = form.getValues('type') as DependencyType;
    setAddingId(dependsOnId);
    try {
      await addServiceDependency(serviceId, dependsOnId, addType);
      toast.success('Dependency added');
      await loadDependencies();
      onUpdate?.();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to add dependency'));
    } finally {
      setAddingId(null);
    }
  };

  const handleRemove = async (dependencyId: string) => {
    const confirmed = await confirm({
      title: 'Remove dependency',
      description: 'Remove this dependency?',
      confirmText: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    setRemovingId(dependencyId);
    try {
      await removeServiceDependency(dependencyId);
      toast.success('Dependency removed');
      await loadDependencies();
      onUpdate?.();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to remove dependency'));
    } finally {
      setRemovingId(null);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-2">
        <div className="h-8 rounded bg-muted"></div>
        <div className="h-8 rounded bg-muted"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {/* Dependencies (services this service depends on) */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-medium text-muted-foreground">
            Depends On ({dependencies.length})
          </h4>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowAdd(!showAdd)}
          >
            {showAdd ? (
              'Cancel'
            ) : (
              <>
                <Plus className="size-4" />
                Add Dependency
              </>
            )}
          </Button>
        </div>

        {showAdd && (
          <div className="mb-4 space-y-3 rounded bg-muted/50 p-3">
            <Form {...form}>
              <form className="space-y-3" onSubmit={(e) => e.preventDefault()}>
                <FormField
                  control={form.control}
                  name="type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs text-muted-foreground">
                        Dependency Type
                      </FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full text-sm">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="health_before">
                            Health Before (wait for healthy)
                          </SelectItem>
                          <SelectItem value="deploy_after">
                            Deploy After (no health wait)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </form>
            </Form>

            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {serviceName} will deploy after:
              </label>
              {available.length === 0 ? (
                <p className="text-sm text-muted-foreground">No available services to depend on</p>
              ) : (
                <div className="max-h-32 space-y-1 overflow-y-auto">
                  {available.map((service) => {
                    const servers = service.serviceDeployments
                      .map((d) => d.server.name)
                      .join(', ');
                    return (
                      <div
                        key={service.id}
                        className="flex items-center justify-between rounded bg-card p-2"
                      >
                        <div>
                          <span className="text-sm text-foreground">{service.name}</span>
                          {servers && (
                            <span className="ml-2 text-xs text-muted-foreground">on {servers}</span>
                          )}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => handleAdd(service.id)}
                          disabled={addingId === service.id}
                        >
                          {addingId === service.id ? '...' : 'Add'}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {dependencies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No dependencies configured</p>
        ) : (
          <div className="space-y-2">
            {dependencies.map((dep) => (
              <div
                key={dep.id}
                className="flex items-center justify-between rounded bg-muted/50 p-2"
              >
                <div className="flex items-center gap-2">
                  <Badge variant={dep.type === 'health_before' ? 'success' : 'info'}>
                    {dep.type === 'health_before' ? 'health' : 'deploy'}
                  </Badge>
                  <span className="text-sm text-foreground">{dep.dependsOn.name}</span>
                  {dep.dependsOn.server?.name && (
                    <span className="text-xs text-muted-foreground">
                      on {dep.dependsOn.server.name}
                    </span>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleRemove(dep.id)}
                  disabled={removingId === dep.id}
                  aria-label="Remove dependency"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dependents (services that depend on this service) */}
      {dependents.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-muted-foreground">
            Required By ({dependents.length})
          </h4>
          <div className="space-y-2">
            {dependents.map((dep) => (
              <div
                key={dep.id}
                className="flex items-center gap-2 rounded bg-muted/30 p-2 text-sm"
              >
                <Badge variant={dep.type === 'health_before' ? 'success' : 'info'}>
                  {dep.type === 'health_before' ? 'health' : 'deploy'}
                </Badge>
                <span className="text-foreground">{dep.dependent.name}</span>
                {dep.dependent.server?.name && (
                  <span className="text-xs text-muted-foreground">
                    on {dep.dependent.server.name}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
