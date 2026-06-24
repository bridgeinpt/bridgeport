import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Terminal, Cpu, SlidersHorizontal, Clock, Link2, Database, AlertTriangle, Archive } from 'lucide-react';
import { getSystemSettings, updateSystemSettings, resetSystemSettings } from '../../lib/api';
import { toast } from '../../components/Toast';
import { getErrorMessage } from '@/lib/helpers';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  RetentionPolicyFields,
  RETENTION_BOUNDS,
  type RetentionPolicyValues,
} from '@/components/RetentionPolicyFields';

/**
 * IANA timezone list for the instance-timezone selector (issue #291 §11.3).
 * `Intl.supportedValuesOf` is widely available; fall back to a free-text input
 * if the runtime lacks it.
 */
const TIMEZONES: string[] | null = (() => {
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
    return typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : null;
  } catch {
    return null;
  }
})();

const settingsSchema = z.object({
  sshCommandTimeoutSec: z.number().int().min(1).max(600),
  sshReadyTimeoutSec: z.number().int().min(1).max(120),
  maxUploadSizeMb: z.number().int().min(1).max(500),
  pgDumpTimeoutSec: z.number().int().min(30).max(3600),
  activeUserWindowMin: z.number().int().min(1).max(1440),
  registryMaxTags: z.number().int().min(10).max(500),
  defaultLogLines: z.number().int().min(10).max(10000),
  publicUrl: z.string(),
  agentCallbackUrl: z.string(),
  agentStaleThresholdSec: z.number().int().min(60).max(600),
  agentOfflineThresholdSec: z.number().int().min(120).max(900),
  auditLogRetentionDays: z.number().int().min(0).max(3650),
  databaseMetricsRetentionDays: z.number().int().min(1).max(365),
  notificationRetentionDays: z.number().int().min(1).max(365),
  healthLogRetentionDays: z.number().int().min(1).max(365),
  webhookDeliveryRetentionDays: z.number().int().min(1).max(365),
  imageDigestRetentionDays: z.number().int().min(1).max(3650),
  // Backup rotation & retention (issue #291)
  timezone: z.string().min(1),
  backupRetentionPreset: z.enum(['lean', 'balanced', 'long_term', 'custom']),
  backupRetentionKeepLast: z.number().int().min(RETENTION_BOUNDS.keepLast.min).max(RETENTION_BOUNDS.keepLast.max),
  backupRetentionDaily: z.number().int().min(RETENTION_BOUNDS.daily.min).max(RETENTION_BOUNDS.daily.max),
  backupRetentionWeekly: z.number().int().min(RETENTION_BOUNDS.weekly.min).max(RETENTION_BOUNDS.weekly.max),
  backupRetentionMonthly: z.number().int().min(RETENTION_BOUNDS.monthly.min).max(RETENTION_BOUNDS.monthly.max),
  backupRetentionYearly: z.number().int().min(RETENTION_BOUNDS.yearly.min).max(RETENTION_BOUNDS.yearly.max),
  backupRetentionMinFloor: z.number().int().min(RETENTION_BOUNDS.minFloor.min).max(RETENTION_BOUNDS.minFloor.max),
  // Bytes; null = off. Edited in GB via RetentionPolicyFields.
  backupRetentionMaxTotalBytes: z.number().int().min(0).nullable(),
  failedBackupRetentionDays: z.number().int().min(1).max(3650),
  backupRotationConfirmThreshold: z.number().int().min(0).max(10000),
});

type FormData = z.infer<typeof settingsSchema>;

interface Defaults {
  sshCommandTimeoutMs: number;
  sshReadyTimeoutMs: number;
  maxUploadSizeMb: number;
  pgDumpTimeoutMs: number;
  activeUserWindowMin: number;
  registryMaxTags: number;
  defaultLogLines: number;
  agentStaleThresholdMs: number;
  agentOfflineThresholdMs: number;
  auditLogRetentionDays: number;
  databaseMetricsRetentionDays: number;
  notificationRetentionDays: number;
  healthLogRetentionDays: number;
  webhookDeliveryRetentionDays: number;
  imageDigestRetentionDays: number;
  failedBackupRetentionDays: number;
  backupRotationConfirmThreshold: number;
}

function msToSec(ms: number): number {
  return Math.round(ms / 1000);
}

function secToMs(sec: number): number {
  return sec * 1000;
}

const DEFAULT_FORM: FormData = {
  sshCommandTimeoutSec: 60,
  sshReadyTimeoutSec: 10,
  maxUploadSizeMb: 50,
  pgDumpTimeoutSec: 300,
  activeUserWindowMin: 15,
  registryMaxTags: 50,
  defaultLogLines: 50,
  publicUrl: '',
  agentCallbackUrl: '',
  agentStaleThresholdSec: 180,
  agentOfflineThresholdSec: 300,
  auditLogRetentionDays: 90,
  databaseMetricsRetentionDays: 30,
  notificationRetentionDays: 30,
  healthLogRetentionDays: 30,
  webhookDeliveryRetentionDays: 30,
  imageDigestRetentionDays: 90,
  timezone: 'UTC',
  backupRetentionPreset: 'balanced',
  backupRetentionKeepLast: 24,
  backupRetentionDaily: 7,
  backupRetentionWeekly: 4,
  backupRetentionMonthly: 6,
  backupRetentionYearly: 0,
  backupRetentionMinFloor: 2,
  backupRetentionMaxTotalBytes: null,
  failedBackupRetentionDays: 3,
  backupRotationConfirmThreshold: 5,
};

// Map an API settings payload to the seconds/string form shape.
function settingsToForm(settings: Awaited<ReturnType<typeof getSystemSettings>>['settings']): FormData {
  return {
    sshCommandTimeoutSec: msToSec(settings.sshCommandTimeoutMs),
    sshReadyTimeoutSec: msToSec(settings.sshReadyTimeoutMs),
    maxUploadSizeMb: settings.maxUploadSizeMb,
    pgDumpTimeoutSec: msToSec(settings.pgDumpTimeoutMs),
    activeUserWindowMin: settings.activeUserWindowMin,
    registryMaxTags: settings.registryMaxTags,
    defaultLogLines: settings.defaultLogLines,
    publicUrl: settings.publicUrl || '',
    agentCallbackUrl: settings.agentCallbackUrl || '',
    agentStaleThresholdSec: msToSec(settings.agentStaleThresholdMs),
    agentOfflineThresholdSec: msToSec(settings.agentOfflineThresholdMs),
    auditLogRetentionDays: settings.auditLogRetentionDays,
    databaseMetricsRetentionDays: settings.databaseMetricsRetentionDays ?? 30,
    notificationRetentionDays: settings.notificationRetentionDays ?? 30,
    healthLogRetentionDays: settings.healthLogRetentionDays ?? 30,
    webhookDeliveryRetentionDays: settings.webhookDeliveryRetentionDays ?? 30,
    imageDigestRetentionDays: settings.imageDigestRetentionDays ?? 90,
    timezone: settings.timezone || 'UTC',
    backupRetentionPreset: settings.backupRetentionPreset ?? 'balanced',
    backupRetentionKeepLast: settings.backupRetentionKeepLast ?? 24,
    backupRetentionDaily: settings.backupRetentionDaily ?? 7,
    backupRetentionWeekly: settings.backupRetentionWeekly ?? 4,
    backupRetentionMonthly: settings.backupRetentionMonthly ?? 6,
    backupRetentionYearly: settings.backupRetentionYearly ?? 0,
    backupRetentionMinFloor: settings.backupRetentionMinFloor ?? 2,
    backupRetentionMaxTotalBytes: settings.backupRetentionMaxTotalBytes ?? null,
    failedBackupRetentionDays: settings.failedBackupRetentionDays ?? 3,
    backupRotationConfirmThreshold: settings.backupRotationConfirmThreshold ?? 5,
  };
}

/** Number-input helper: empty → 0, else the parsed numeric value. */
const toNumber = (value: string) => (value === '' ? 0 : Number(value));

function SettingsSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-base">
          <Icon className="size-5 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default function SystemSettings() {
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [defaults, setDefaults] = useState<Defaults | null>(null);

  const form = useForm<FormData>({
    resolver: zodResolver(settingsSchema),
    defaultValues: DEFAULT_FORM,
  });

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const { settings, defaults } = await getSystemSettings();
      setDefaults(defaults);
      form.reset(settingsToForm(settings));
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to load settings'));
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = async (values: FormData) => {
    try {
      const updateData: Parameters<typeof updateSystemSettings>[0] = {
        sshCommandTimeoutMs: secToMs(values.sshCommandTimeoutSec),
        sshReadyTimeoutMs: secToMs(values.sshReadyTimeoutSec),
        maxUploadSizeMb: values.maxUploadSizeMb,
        pgDumpTimeoutMs: secToMs(values.pgDumpTimeoutSec),
        activeUserWindowMin: values.activeUserWindowMin,
        registryMaxTags: values.registryMaxTags,
        defaultLogLines: values.defaultLogLines,
        publicUrl: values.publicUrl || null,
        agentCallbackUrl: values.agentCallbackUrl || null,
        agentStaleThresholdMs: secToMs(values.agentStaleThresholdSec),
        agentOfflineThresholdMs: secToMs(values.agentOfflineThresholdSec),
        auditLogRetentionDays: values.auditLogRetentionDays,
        databaseMetricsRetentionDays: values.databaseMetricsRetentionDays,
        notificationRetentionDays: values.notificationRetentionDays,
        healthLogRetentionDays: values.healthLogRetentionDays,
        webhookDeliveryRetentionDays: values.webhookDeliveryRetentionDays,
        imageDigestRetentionDays: values.imageDigestRetentionDays,
        timezone: values.timezone,
        backupRetentionPreset: values.backupRetentionPreset,
        backupRetentionKeepLast: values.backupRetentionKeepLast,
        backupRetentionDaily: values.backupRetentionDaily,
        backupRetentionWeekly: values.backupRetentionWeekly,
        backupRetentionMonthly: values.backupRetentionMonthly,
        backupRetentionYearly: values.backupRetentionYearly,
        backupRetentionMinFloor: values.backupRetentionMinFloor,
        backupRetentionMaxTotalBytes: values.backupRetentionMaxTotalBytes,
        failedBackupRetentionDays: values.failedBackupRetentionDays,
        backupRotationConfirmThreshold: values.backupRotationConfirmThreshold,
      };
      await updateSystemSettings(updateData);
      // Reset to the just-saved values so the form is no longer dirty.
      form.reset(values);
      toast.success('Settings saved successfully');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to save settings'));
    }
  };

  const handleReset = async () => {
    const confirmed = await confirm({
      title: 'Reset settings',
      description: 'Are you sure you want to reset all settings to defaults?',
      confirmText: 'Reset to Defaults',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      setResetting(true);
      const { settings } = await resetSystemSettings();
      form.reset(settingsToForm(settings));
      toast.success('Settings reset to defaults');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to reset settings'));
    } finally {
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const saving = form.formState.isSubmitting;
  const isDirty = form.formState.isDirty;

  // Bridge the flat backupRetention* form fields to the shared editor's value shape.
  const retentionValues: RetentionPolicyValues = {
    preset: form.watch('backupRetentionPreset'),
    keepLast: form.watch('backupRetentionKeepLast'),
    daily: form.watch('backupRetentionDaily'),
    weekly: form.watch('backupRetentionWeekly'),
    monthly: form.watch('backupRetentionMonthly'),
    yearly: form.watch('backupRetentionYearly'),
    minFloor: form.watch('backupRetentionMinFloor'),
    maxTotalBytes: form.watch('backupRetentionMaxTotalBytes'),
  };
  const RETENTION_FIELD_MAP: Record<keyof RetentionPolicyValues, keyof FormData> = {
    preset: 'backupRetentionPreset',
    keepLast: 'backupRetentionKeepLast',
    daily: 'backupRetentionDaily',
    weekly: 'backupRetentionWeekly',
    monthly: 'backupRetentionMonthly',
    yearly: 'backupRetentionYearly',
    minFloor: 'backupRetentionMinFloor',
    maxTotalBytes: 'backupRetentionMaxTotalBytes',
  };
  const patchRetention = (patch: Partial<RetentionPolicyValues>) => {
    for (const [k, v] of Object.entries(patch) as [keyof RetentionPolicyValues, never][]) {
      form.setValue(RETENTION_FIELD_MAP[k], v, { shouldDirty: true, shouldValidate: true });
    }
  };

  return (
    <div className="p-6">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* SSH Configuration */}
          <SettingsSection title="SSH Configuration" icon={Terminal}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="sshCommandTimeoutSec"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Command Timeout (seconds)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={600}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Max time for SSH command execution (default: {defaults ? msToSec(defaults.sshCommandTimeoutMs) : 60}s)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="sshReadyTimeoutSec"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Connection Timeout (seconds)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={120}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      SSH connection establishment timeout (default: {defaults ? msToSec(defaults.sshReadyTimeoutMs) : 10}s)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </SettingsSection>

          {/* URLs */}
          <SettingsSection title="URLs" icon={Link2}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="publicUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Public URL</FormLabel>
                    <FormControl>
                      <Input type="text" placeholder="https://deploy.example.com" {...field} />
                    </FormControl>
                    <FormDescription>Public URL for links in email and Slack notifications</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="agentCallbackUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Agent Callback URL <span className="text-warning">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input type="text" placeholder="http://10.30.10.5:3000" {...field} />
                    </FormControl>
                    <FormDescription>
                      Internal URL for agents to reach BRIDGEPORT (VPC IP).
                      <span className="font-medium text-warning"> Required for agent deployment.</span>
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </SettingsSection>

          {/* Agent Configuration */}
          <SettingsSection title="Agent Configuration" icon={Cpu}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="agentStaleThresholdSec"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Stale Threshold (seconds)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={60}
                        max={600}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Mark agent as "stale" after no push for this time (default: {defaults ? msToSec(defaults.agentStaleThresholdMs) : 180}s)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="agentOfflineThresholdSec"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Offline Threshold (seconds)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={120}
                        max={900}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Mark agent as "offline" and alert after no push for this time (default: {defaults ? msToSec(defaults.agentOfflineThresholdMs) : 300}s)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </SettingsSection>

          {/* Limits */}
          <SettingsSection title="Limits" icon={SlidersHorizontal}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="maxUploadSizeMb"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max Upload Size (MB)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={500}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Maximum file upload size (default: {defaults?.maxUploadSizeMb || 50} MB)
                    </FormDescription>
                    <p className="mt-1 flex items-center gap-1 text-xs text-warning">
                      <AlertTriangle className="size-3" />
                      Requires server restart to take effect
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="activeUserWindowMin"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Active User Window (minutes)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={1440}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Window for "active user" status (default: {defaults?.activeUserWindowMin || 15} min)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="registryMaxTags"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Registry Max Tags</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={10}
                        max={500}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Maximum tags to fetch from registry (default: {defaults?.registryMaxTags || 50})
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="defaultLogLines"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Default Log Lines</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={10}
                        max={10000}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Default tail lines for container logs (default: {defaults?.defaultLogLines || 50})
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </SettingsSection>

          {/* Database & Backup */}
          <SettingsSection title="Database & Backup" icon={Database}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="pgDumpTimeoutSec"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>pg_dump Timeout (seconds)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={30}
                        max={3600}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Global default timeout for PostgreSQL backup dumps (30–3600s, default: {defaults ? msToSec(defaults.pgDumpTimeoutMs) : 300}s).
                      Per-database settings override this value.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </SettingsSection>

          {/* Backup Retention (GFS rotation — issue #291) */}
          <SettingsSection title="Backup Retention" icon={Archive}>
            <div className="space-y-6">
              {/* Instance timezone — used to bucket GFS periods (daily/weekly/…). */}
              <FormField
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <FormItem className="md:max-w-md">
                    <FormLabel>Instance Timezone</FormLabel>
                    <FormControl>
                      {TIMEZONES ? (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="UTC" />
                          </SelectTrigger>
                          <SelectContent className="max-h-72">
                            {TIMEZONES.map((tz) => (
                              <SelectItem key={tz} value={tz}>
                                {tz}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input type="text" placeholder="UTC" {...field} />
                      )}
                    </FormControl>
                    <FormDescription>
                      Timezone for backup-rotation period bucketing and display (default: UTC). ISO weeks start Monday.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Global default GFS policy (inherited by databases without an override). */}
              <div className="space-y-1.5">
                <Label>Global default policy</Label>
                <p className="text-xs text-muted-foreground">
                  Databases without a per-database override inherit this policy.
                </p>
                <div className="pt-1">
                  <RetentionPolicyFields
                    idPrefix="global-retention"
                    values={retentionValues}
                    onChange={patchRetention}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="failedBackupRetentionDays"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Failed Backup Retention (days)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          max={3650}
                          {...field}
                          onChange={(e) => field.onChange(toNumber(e.target.value))}
                        />
                      </FormControl>
                      <FormDescription>
                        Days to keep failed/stuck backups before cleanup (default: {defaults?.failedBackupRetentionDays ?? 3} days)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="backupRotationConfirmThreshold"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Rotation Confirm Threshold</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          max={10000}
                          {...field}
                          onChange={(e) => field.onChange(toNumber(e.target.value))}
                        />
                      </FormControl>
                      <FormDescription>
                        Prompt for confirmation when a policy change would prune more than this many backups at once
                        (default: {defaults?.backupRotationConfirmThreshold ?? 5})
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>
          </SettingsSection>

          {/* Retention */}
          <SettingsSection title="Retention" icon={Clock}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="auditLogRetentionDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Audit Log Retention (days)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={3650}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Days to keep audit logs (default: {defaults?.auditLogRetentionDays || 90} days, 0 = keep forever)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="databaseMetricsRetentionDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Database Metrics Retention (days)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={365}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Days to keep database monitoring metrics (default: {defaults?.databaseMetricsRetentionDays || 30} days)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="notificationRetentionDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notification Retention (days)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={365}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Days to keep delivered in-app notifications (default: {defaults?.notificationRetentionDays || 30} days)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="healthLogRetentionDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Health Check Log Retention (days)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={365}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Days to keep server and service health check logs (default: {defaults?.healthLogRetentionDays || 30} days)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="webhookDeliveryRetentionDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Webhook Delivery Retention (days)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={365}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Days to keep webhook delivery attempt history (default: {defaults?.webhookDeliveryRetentionDays || 30} days)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="imageDigestRetentionDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Image Digest Retention (days)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={3650}
                        {...field}
                        onChange={(e) => field.onChange(toNumber(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Days to keep container image digest history (default: {defaults?.imageDigestRetentionDays || 90} days)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </SettingsSection>

          {/* Actions */}
          <div className="flex items-center justify-between pt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={handleReset}
              disabled={resetting || saving}
            >
              {resetting ? 'Resetting...' : 'Reset to Defaults'}
            </Button>
            <Button type="submit" disabled={saving || resetting || !isDirty}>
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
