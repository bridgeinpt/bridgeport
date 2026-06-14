import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check, X } from 'lucide-react';
import { useAuthStore, isAdmin } from '../../lib/store';
import {
  getGlobalSpacesConfig,
  updateGlobalSpacesConfig,
  deleteGlobalSpacesConfig,
  testGlobalSpacesConfig,
  getSpacesEnvironments,
  setSpacesEnvironmentEnabled,
  type GlobalSpacesConfig,
  type SpacesEnvironmentStatus,
} from '../../lib/api';
import { useToast } from '../../components/Toast';
import { getErrorMessage } from '@/lib/helpers';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Label } from '@/components/ui/label';

const configSchema = z.object({
  accessKey: z.string().min(1, 'Access key is required'),
  secretKey: z.string(),
  region: z.string().min(1, 'Region is required'),
});

type ConfigValues = z.infer<typeof configSchema>;

const EMPTY_FORM: ConfigValues = { accessKey: '', secretKey: '', region: 'fra1' };

export default function Storage() {
  const { user } = useAuthStore();
  const toast = useToast();
  const confirm = useConfirm();
  const [config, setConfig] = useState<GlobalSpacesConfig | null>(null);
  const [configured, setConfigured] = useState(false);
  const [environments, setEnvironments] = useState<SpacesEnvironmentStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [buckets, setBuckets] = useState<string[]>([]);
  const [newBucket, setNewBucket] = useState('');
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    buckets?: string[];
    failedBuckets?: string[];
    scopedKey?: boolean;
  } | null>(null);

  const form = useForm<ConfigValues>({
    resolver: zodResolver(configSchema),
    defaultValues: EMPTY_FORM,
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [configRes, envsRes] = await Promise.all([
        getGlobalSpacesConfig(),
        getSpacesEnvironments(),
      ]);
      setConfigured(configRes.configured);
      setConfig(configRes.config);
      setEnvironments(envsRes.environments);
    } catch {
      toast.error('Failed to load Spaces configuration');
    } finally {
      setLoading(false);
    }
  };

  const openEditor = (initial: ConfigValues, initialBuckets: string[]) => {
    form.reset(initial);
    setBuckets(initialBuckets);
    setNewBucket('');
    setTestResult(null);
    setEditing(true);
  };

  const closeEditor = () => {
    setEditing(false);
    form.reset(EMPTY_FORM);
    setBuckets([]);
    setNewBucket('');
  };

  const onSubmit = async (values: ConfigValues) => {
    // Secret key is only required for new configs.
    if (!configured && !values.secretKey) {
      form.setError('secretKey', { message: 'Secret key is required for new configuration' });
      return;
    }
    try {
      await updateGlobalSpacesConfig({
        accessKey: values.accessKey,
        secretKey: values.secretKey || undefined, // Only send if provided
        region: values.region,
        buckets: buckets.length > 0 ? buckets : undefined,
      });
      toast.success('Spaces configuration saved');
      closeEditor();
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save configuration'));
    }
  };

  const handleAddBucket = () => {
    const bucket = newBucket.trim();
    if (bucket && !buckets.includes(bucket)) {
      setBuckets([...buckets, bucket]);
      setNewBucket('');
    }
  };

  const handleRemoveBucket = (bucket: string) => {
    setBuckets(buckets.filter((b) => b !== bucket));
  };

  const handleDelete = async () => {
    const confirmed = await confirm({
      title: 'Remove Spaces configuration',
      description: 'This will disable cloud backups for all environments.',
      confirmText: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await deleteGlobalSpacesConfig();
      toast.success('Spaces configuration removed');
      setConfig(null);
      setConfigured(false);
      loadData();
    } catch {
      toast.error('Failed to remove configuration');
    } finally {
      setDeleting(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testGlobalSpacesConfig();
      setTestResult(result);
      if (result.success) {
        toast.success('Connection successful');
      }
    } catch (error) {
      const message = getErrorMessage(error, 'Connection test failed');
      setTestResult({ success: false, message });
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  const handleToggleEnvironment = async (envId: string, enabled: boolean) => {
    try {
      await setSpacesEnvironmentEnabled(envId, enabled);
      setEnvironments((prev) =>
        prev.map((env) => (env.id === envId ? { ...env, spacesEnabled: enabled } : env))
      );
      toast.success(`Spaces ${enabled ? 'enabled' : 'disabled'} for environment`);
    } catch {
      toast.error('Failed to update environment');
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const saving = form.formState.isSubmitting;

  return (
    <div className="p-6">
      {/* Configuration Card */}
      <Card className="mb-6">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-lg">Connection Settings</CardTitle>
          {configured && isAdmin(user) && (
            <Button
              onClick={handleDelete}
              disabled={deleting}
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
            >
              Remove
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {configured && config ? (
            <div className="rounded-lg border bg-muted/40 p-4">
              <div className="mb-3 flex items-center gap-2">
                <StatusBadge kind="sync" value="synced" label="Configured" />
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Access Key:</span>
                  <span className="font-mono text-foreground">{config.accessKey}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Region:</span>
                  <span className="text-foreground">{config.region}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Endpoint:</span>
                  <span className="font-mono text-xs text-foreground">{config.endpoint}</span>
                </div>
                {config.buckets && config.buckets.length > 0 && (
                  <div className="mt-2 flex justify-between text-muted-foreground">
                    <span>Buckets:</span>
                    <div className="flex flex-wrap justify-end gap-1">
                      {config.buckets.map((bucket) => (
                        <Badge key={bucket} variant="secondary" className="font-mono">
                          {bucket}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {(!config.buckets || config.buckets.length === 0) && (
                  <div className="mt-2 flex justify-between text-muted-foreground">
                    <span>Key Type:</span>
                    <span className="text-xs text-foreground">Full API Access</span>
                  </div>
                )}
              </div>

              {testResult && (
                <div
                  className={`mt-4 rounded-lg border p-3 ${
                    testResult.success
                      ? 'border-success/30 bg-success/10'
                      : 'border-destructive/30 bg-destructive/10'
                  }`}
                >
                  <div className="mb-1 flex items-center gap-2">
                    {testResult.success ? (
                      <Check className="size-4 text-success" />
                    ) : (
                      <X className="size-4 text-destructive" />
                    )}
                    <span className={testResult.success ? 'text-success' : 'text-destructive'}>
                      {testResult.message}
                    </span>
                  </div>
                  {testResult.success && testResult.buckets && testResult.buckets.length > 0 && (
                    <div className="mt-2 text-sm">
                      <span className="text-muted-foreground">
                        {testResult.scopedKey ? 'Accessible buckets:' : 'Available buckets:'}
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {testResult.buckets.map((bucket) => (
                          <Badge key={bucket} variant="secondary" className="font-mono">
                            {bucket}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {testResult.success && testResult.failedBuckets && testResult.failedBuckets.length > 0 && (
                    <div className="mt-2 text-sm">
                      <span className="text-destructive">Inaccessible buckets:</span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {testResult.failedBuckets.map((bucket) => (
                          <Badge key={bucket} variant="destructive" className="font-mono">
                            {bucket}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <Button onClick={handleTest} disabled={testing} variant="secondary" size="sm">
                  {testing ? 'Testing...' : 'Test Connection'}
                </Button>
                {isAdmin(user) && (
                  <Button
                    onClick={() =>
                      openEditor(
                        { accessKey: config.accessKey, secretKey: '', region: config.region },
                        config.buckets || []
                      )
                    }
                    variant="ghost"
                    size="sm"
                  >
                    Edit
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border bg-muted/40 p-4 text-center">
              <p className="mb-4 text-muted-foreground">
                Spaces is not configured. Configure it to enable cloud backups for databases.
              </p>
              {isAdmin(user) && (
                <Button onClick={() => openEditor(EMPTY_FORM, [])}>Configure Spaces</Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Environments Card */}
      {configured && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Environment Access</CardTitle>
            <CardDescription>Enable or disable Spaces access for each environment</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {environments.map((env) => (
                <div
                  key={env.id}
                  className="flex items-center justify-between rounded-lg border bg-muted/40 p-3"
                >
                  <span className="font-medium text-foreground">{env.name}</span>
                  <Switch
                    checked={env.spacesEnabled}
                    onCheckedChange={(checked) => handleToggleEnvironment(env.id, checked)}
                    disabled={!isAdmin(user)}
                    aria-label={`Toggle Spaces for ${env.name}`}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Edit/Create Dialog */}
      <Dialog open={editing} onOpenChange={(open) => !open && closeEditor()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{configured ? 'Edit Spaces Configuration' : 'Configure Spaces'}</DialogTitle>
            <DialogDescription>
              S3-compatible object storage credentials for cloud backups.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="accessKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Access Key</FormLabel>
                      <FormControl>
                        <Input type="text" placeholder="Access key ID" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="secretKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Secret Key{' '}
                        {configured && (
                          <span className="text-muted-foreground">(leave empty to keep current)</span>
                        )}
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder={configured ? 'Leave empty to keep current' : 'Enter secret key'}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="region"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Region</FormLabel>
                    <FormControl>
                      <Input type="text" placeholder="e.g. us-east-1, fra1" {...field} />
                    </FormControl>
                    <FormDescription>
                      Region identifier for your S3-compatible provider.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div>
                <Label>
                  Buckets <span className="text-muted-foreground">(optional - for scoped keys)</span>
                </Label>
                <p className="mb-2 mt-1 text-xs text-muted-foreground">
                  If your key only has access to specific buckets, add them here. Leave empty for keys
                  with full API access.
                </p>
                <div className="mb-2 flex gap-2">
                  <Input
                    type="text"
                    value={newBucket}
                    onChange={(e) => setNewBucket(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddBucket();
                      }
                    }}
                    placeholder="bucket-name"
                    className="flex-1"
                  />
                  <Button type="button" onClick={handleAddBucket} variant="secondary">
                    Add
                  </Button>
                </div>
                {buckets.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {buckets.map((bucket) => (
                      <Badge key={bucket} variant="secondary" className="gap-1 font-mono">
                        {bucket}
                        <button
                          type="button"
                          onClick={() => handleRemoveBucket(bucket)}
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Remove ${bucket}`}
                        >
                          <X className="size-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={closeEditor}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? 'Saving...' : 'Save Configuration'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
