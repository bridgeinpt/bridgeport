import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { bytesToGb, gbToBytes } from '@/lib/helpers';
import type { BackupRetentionPreset } from '@/lib/api';

/**
 * GFS retention policy editor (issue #291 §11). Presentational + controlled:
 * the parent owns the form state (and its zod validation) and passes the
 * current values plus an `onChange` patcher. Shared between the per-database
 * policy panel (DatabaseDetail) and the admin global default (SystemSettings).
 */

export interface RetentionPolicyValues {
  preset: BackupRetentionPreset;
  keepLast: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
  minFloor: number;
  /** Absolute storage ceiling in BYTES; null = off. Edited as GB in the UI. */
  maxTotalBytes: number | null;
}

/** Inclusive bounds — mirror RETENTION_BOUNDS in the backend (§4). */
export const RETENTION_BOUNDS = {
  keepLast: { min: 0, max: 100 },
  daily: { min: 0, max: 366 },
  weekly: { min: 0, max: 520 },
  monthly: { min: 0, max: 240 },
  yearly: { min: 0, max: 50 },
  minFloor: { min: 1, max: 10 },
} as const;

export const PRESET_OPTIONS: { value: BackupRetentionPreset; label: string; hint: string }[] = [
  { value: 'lean', label: 'Lean', hint: '12 recent · 7d · 4w' },
  { value: 'balanced', label: 'Balanced', hint: '24 recent · 7d · 4w · 6m' },
  { value: 'long_term', label: 'Long-term', hint: '24 recent · 7d · 4w · 12m · 3y' },
  { value: 'custom', label: 'Custom', hint: 'Set each tier yourself' },
];

/**
 * Tier values for each non-custom preset — mirrors PRESETS in the backend
 * (src/services/database-backup.ts §4.1). Selecting a preset fills these tier
 * fields in the form so the persisted values match the chosen preset (the
 * inputs are hidden for non-custom presets, so without this the form would keep
 * whatever stale tiers were last shown). `maxTotalBytes` is always off (null)
 * for a preset.
 */
export const PRESET_VALUES: Record<'lean' | 'balanced' | 'long_term', Omit<RetentionPolicyValues, 'preset'>> = {
  lean: { keepLast: 12, daily: 7, weekly: 4, monthly: 0, yearly: 0, minFloor: 2, maxTotalBytes: null },
  balanced: { keepLast: 24, daily: 7, weekly: 4, monthly: 6, yearly: 0, minFloor: 2, maxTotalBytes: null },
  long_term: { keepLast: 24, daily: 7, weekly: 4, monthly: 12, yearly: 3, minFloor: 2, maxTotalBytes: null },
};

const TIER_FIELDS: {
  key: keyof typeof RETENTION_BOUNDS;
  label: string;
  description: string;
}[] = [
  { key: 'keepLast', label: 'Keep last', description: 'Most-recent backups, any age' },
  { key: 'daily', label: 'Daily', description: 'Newest per calendar day' },
  { key: 'weekly', label: 'Weekly', description: 'Newest per ISO week' },
  { key: 'monthly', label: 'Monthly', description: 'Newest per month' },
  { key: 'yearly', label: 'Yearly', description: 'Newest per year' },
  { key: 'minFloor', label: 'Min floor', description: 'Always keep at least' },
];

interface RetentionPolicyFieldsProps {
  values: RetentionPolicyValues;
  onChange: (patch: Partial<RetentionPolicyValues>) => void;
  /** Disable every control (e.g. while inheriting the global default). */
  disabled?: boolean;
  /** Prefix for input ids so multiple instances stay unique/labelable. */
  idPrefix: string;
}

export function RetentionPolicyFields({ values, onChange, disabled, idPrefix }: RetentionPolicyFieldsProps) {
  const showAdvanced = values.preset === 'custom';
  const gbValue = bytesToGb(values.maxTotalBytes);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>Preset</Label>
        <RadioGroup
          value={values.preset}
          onValueChange={(v) => {
            const preset = v as BackupRetentionPreset;
            // For a non-custom preset, also fill the (hidden) tier fields from
            // the preset constants so the form reflects/submits the right
            // numbers — not whatever stale tiers were last shown. 'custom'
            // keeps the current tier values for the user to edit.
            if (preset !== 'custom') {
              onChange({ preset, ...PRESET_VALUES[preset] });
            } else {
              onChange({ preset });
            }
          }}
          disabled={disabled}
          className="gap-2"
        >
          {PRESET_OPTIONS.map((opt) => (
            <Label
              key={opt.value}
              htmlFor={`${idPrefix}-preset-${opt.value}`}
              className="flex items-center gap-3 rounded-md border p-3 text-sm font-normal has-[:checked]:border-primary has-[:disabled]:opacity-60"
            >
              <RadioGroupItem id={`${idPrefix}-preset-${opt.value}`} value={opt.value} />
              <span className="flex flex-col">
                <span className="font-medium text-foreground">{opt.label}</span>
                <span className="text-xs text-muted-foreground">{opt.hint}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </div>

      {showAdvanced && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {TIER_FIELDS.map((tier) => {
              const bounds = RETENTION_BOUNDS[tier.key];
              return (
                <div key={tier.key} className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-${tier.key}`}>{tier.label}</Label>
                  <Input
                    id={`${idPrefix}-${tier.key}`}
                    type="number"
                    min={bounds.min}
                    max={bounds.max}
                    disabled={disabled}
                    value={values[tier.key]}
                    onChange={(e) =>
                      onChange({ [tier.key]: e.target.value === '' ? bounds.min : Number(e.target.value) })
                    }
                  />
                  <p className="text-xs text-muted-foreground">{tier.description}</p>
                </div>
              );
            })}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-maxTotalGb`}>
              Storage cap <span className="text-muted-foreground">(GB, optional)</span>
            </Label>
            <Input
              id={`${idPrefix}-maxTotalGb`}
              type="number"
              min={0}
              step="0.1"
              disabled={disabled}
              placeholder="Off"
              value={gbValue ?? ''}
              onChange={(e) =>
                onChange({ maxTotalBytes: e.target.value === '' ? null : gbToBytes(Number(e.target.value)) })
              }
            />
            <p className="text-xs text-muted-foreground">
              Evict oldest non-pinned scheduled backups past this size. Leave blank to disable.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
