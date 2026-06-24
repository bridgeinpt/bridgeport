import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Info, RotateCw } from 'lucide-react';
import {
  getBackupPolicy,
  setBackupPolicy,
  deleteBackupPolicy,
  previewBackupPolicy,
  rotateDatabaseNow,
  type BackupPolicyResponse,
  type BackupPolicyPreviewResponse,
  type BackupPolicyInput,
  type BackupPolicyConfirmPreview,
} from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/hooks/useConfirm';
import { getErrorMessage, formatBytes } from '@/lib/helpers';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  RetentionPolicyFields,
  RETENTION_BOUNDS,
  type RetentionPolicyValues,
} from '@/components/RetentionPolicyFields';

interface BackupRetentionCardProps {
  databaseId: string;
  /** Called after a rotation/save that may have pruned rows, so the parent can refresh its backup list. */
  onRotated?: () => void;
}

const PREVIEW_DEBOUNCE_MS = 400;

/** Clamp a tier value to its bound; used to keep out-of-range inputs from hitting the API. */
function withinBounds(values: RetentionPolicyValues): boolean {
  return (Object.keys(RETENTION_BOUNDS) as (keyof typeof RETENTION_BOUNDS)[]).every((k) => {
    const v = values[k];
    return Number.isFinite(v) && v >= RETENTION_BOUNDS[k].min && v <= RETENTION_BOUNDS[k].max;
  });
}

export function BackupRetentionCard({ databaseId, onRotated }: BackupRetentionCardProps) {
  const toast = useToast();
  const confirm = useConfirm();

  const [loading, setLoading] = useState(true);
  const [policy, setPolicy] = useState<BackupPolicyResponse | null>(null);
  const [inheritGlobal, setInheritGlobal] = useState(false);
  const [values, setValues] = useState<RetentionPolicyValues>({
    preset: 'balanced',
    keepLast: 24,
    daily: 7,
    weekly: 4,
    monthly: 6,
    yearly: 0,
    minFloor: 2,
    maxTotalBytes: null,
  });

  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [preview, setPreview] = useState<BackupPolicyPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const seedFromResponse = useCallback((res: BackupPolicyResponse) => {
    setPolicy(res);
    setInheritGlobal(res.source === 'inherited');
    // Seed the editable tiers from the effective policy (what's in force now).
    const eff = res.effective;
    setValues({
      preset: (eff.preset as RetentionPolicyValues['preset']) ?? 'balanced',
      keepLast: eff.keepLast,
      daily: eff.daily,
      weekly: eff.weekly,
      monthly: eff.monthly,
      yearly: eff.yearly,
      minFloor: eff.minFloor,
      maxTotalBytes: eff.maxTotalBytes,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getBackupPolicy(databaseId)
      .then((res) => {
        if (!cancelled) seedFromResponse(res);
      })
      .catch((err) => {
        if (!cancelled) toast.error(getErrorMessage(err, 'Failed to load retention policy'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [databaseId, seedFromResponse, toast]);

  // The size cap only applies to Custom; presets always run with the cap off
  // (matches the backend, which fills tiers from PRESETS but still reads the
  // body cap — so we explicitly clear it for a non-custom preset in the bodies below).
  // Build the policy body that mirrors the current editor state.
  const buildBody = useCallback(
    (extra?: Partial<BackupPolicyInput>): BackupPolicyInput => ({
      inheritGlobal,
      preset: values.preset,
      keepLast: values.keepLast,
      daily: values.daily,
      weekly: values.weekly,
      monthly: values.monthly,
      yearly: values.yearly,
      minFloor: values.minFloor,
      maxTotalBytes: values.preset === 'custom' ? values.maxTotalBytes : null,
      ...extra,
    }),
    [inheritGlobal, values]
  );

  // Live, server-authoritative keep/prune preview (debounced on change).
  const valid = withinBounds(values);
  useEffect(() => {
    if (loading || !valid) return;
    let cancelled = false;
    setPreviewing(true);
    const handle = setTimeout(() => {
      // When inheriting, preview the global default; otherwise the edited tiers.
      const body = inheritGlobal
        ? { inheritGlobal: true }
        : {
            preset: values.preset,
            keepLast: values.keepLast,
            daily: values.daily,
            weekly: values.weekly,
            monthly: values.monthly,
            yearly: values.yearly,
            minFloor: values.minFloor,
            maxTotalBytes: values.preset === 'custom' ? values.maxTotalBytes : null,
          };
      previewBackupPolicy(databaseId, body)
        .then((res) => {
          if (!cancelled) setPreview(res);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [databaseId, loading, valid, inheritGlobal, values]);

  const confirmPrune = useCallback(
    async (p: BackupPolicyConfirmPreview): Promise<boolean> => {
      return confirm({
        title: 'Confirm backup pruning',
        description: (
          <span>
            Applying this policy will prune <span className="font-medium text-foreground">{p.prune.length}</span>{' '}
            backup{p.prune.length === 1 ? '' : 's'}, freeing{' '}
            <span className="font-medium text-foreground">~{formatBytes(p.bytesFreed)}</span>.{' '}
            <span className="font-medium text-foreground">{p.keep.length}</span> will be kept. This permanently
            deletes the pruned backups.
          </span>
        ),
        confirmText: 'Prune & apply',
        destructive: true,
      });
    },
    [confirm]
  );

  const handleSave = async () => {
    if (!valid) {
      toast.error('Some retention values are out of range');
      return;
    }
    setSaving(true);
    try {
      // Turning "Use global default" on with an existing override reverts to inheriting.
      if (inheritGlobal && policy?.override) {
        const res = await deleteBackupPolicy(databaseId);
        setPolicy((prev) => (prev ? { ...prev, effective: res.effective, override: null, source: res.source } : prev));
        toast.success('Reverted to global default policy');
        onRotated?.();
        return;
      }

      let result = await setBackupPolicy(databaseId, buildBody());

      // 409: over-threshold prune needs explicit confirmation, then re-submit.
      if (result.confirmationRequired) {
        const ok = await confirmPrune(result.preview);
        if (!ok) return;
        result = await setBackupPolicy(databaseId, buildBody({ confirm: true }));
        if (result.confirmationRequired) return; // shouldn't recur, but guard
      }

      const pruned = result.rotation.prune.length;
      toast.success(
        pruned > 0
          ? `Policy saved · pruned ${pruned} backup${pruned === 1 ? '' : 's'}, freed ~${formatBytes(result.rotation.bytesFreed)}`
          : 'Retention policy saved'
      );
      if (result.rotation.cappedButUnreachable) {
        toast.warning('Storage cap could not be fully met (pinned/manual backups exceed it)');
      }
      // Reload to reflect the persisted override + new effective policy.
      const fresh = await getBackupPolicy(databaseId);
      seedFromResponse(fresh);
      onRotated?.();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to save policy'));
    } finally {
      setSaving(false);
    }
  };

  const handleRotateNow = async () => {
    setRotating(true);
    try {
      const res = await rotateDatabaseNow(databaseId);
      const pruned = res.prune.length;
      toast.success(
        pruned > 0
          ? `Rotated · pruned ${pruned} backup${pruned === 1 ? '' : 's'}, freed ~${formatBytes(res.bytesFreed)}`
          : 'Rotation complete · nothing to prune'
      );
      if (res.cappedButUnreachable) {
        toast.warning('Storage cap could not be fully met (pinned/manual backups exceed it)');
      }
      if (res.errors && res.errors.length > 0) {
        toast.error(`${res.errors.length} backup(s) failed to delete; will retry on next sweep`);
      }
      onRotated?.();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Rotation failed'));
    } finally {
      setRotating(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Backup retention</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          Backup retention
          {inheritGlobal && (
            <Badge variant="secondary" className="text-xs">
              Inherited from global default
            </Badge>
          )}
        </CardTitle>
        <Button variant="secondary" size="sm" onClick={handleRotateNow} disabled={rotating}>
          <RotateCw className="size-4" />
          {rotating ? 'Rotating...' : 'Rotate now'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Inert (autoApplied) migrated policy: automatic pruning is paused
            until the operator reviews & saves. Cleared server-side on save, so
            this notice disappears after the post-save refetch. */}
        {policy?.effective.autoApplied && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-sm text-info"
          >
            <Info className="mt-0.5 size-4 shrink-0" />
            <span className="text-foreground">
              This retention policy was migrated from your legacy backup settings.{' '}
              <span className="font-medium">Automatic pruning is paused</span> until you review the
              tiers below and save the policy. Saving activates GFS rotation for this database.
            </span>
          </div>
        )}

        {/* Use global default toggle */}
        <Label
          htmlFor="retention-inherit"
          className="flex items-center justify-between gap-3 rounded-md border p-3 font-normal"
        >
          <span className="flex flex-col">
            <span className="text-sm font-medium text-foreground">Use global default</span>
            <span className="text-xs text-muted-foreground">
              Follow the instance-wide retention policy instead of a per-database override.
            </span>
          </span>
          <Switch
            id="retention-inherit"
            checked={inheritGlobal}
            onCheckedChange={(checked) => setInheritGlobal(checked)}
          />
        </Label>

        <RetentionPolicyFields
          idPrefix="db-retention"
          values={values}
          onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
          disabled={inheritGlobal}
        />

        <Separator />

        {/* Live keep/prune preview (server-authoritative dry run). */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Preview</span>
            {previewing && <span className="text-xs text-muted-foreground">updating…</span>}
          </div>
          {!valid ? (
            <p className="text-sm text-warning">Some values are out of range — adjust to preview.</p>
          ) : preview ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-mono">
                <span className="text-success">KEEP {preview.keep.length}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="text-destructive">PRUNE {preview.prune.length}</span>
                <span className="text-muted-foreground"> · frees ~{formatBytes(preview.bytesFreed)}</span>
              </span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No preview available.</p>
          )}
          {preview?.cappedButUnreachable && (
            <p className="flex items-center gap-1 text-xs text-warning">
              <AlertTriangle className="size-3" />
              Storage cap can't be met without removing pinned or manual backups.
            </p>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <Button onClick={handleSave} disabled={saving || !valid}>
            {saving ? 'Saving...' : 'Save policy'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
