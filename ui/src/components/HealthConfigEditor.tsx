import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useToast } from './Toast';
import { updateServiceHealthConfig, type ServiceHealthConfig } from '../lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { getErrorMessage } from '@/lib/helpers';

const healthConfigSchema = z.object({
  healthWaitMs: z.number().int().min(0),
  healthRetries: z.number().int().min(1).max(20),
  healthIntervalMs: z.number().int().min(0),
});

type HealthConfigValues = z.infer<typeof healthConfigSchema>;

interface HealthConfigEditorProps {
  serviceId: string;
  initialConfig: HealthConfigValues;
  onUpdate?: () => void;
}

/** Number-input helper: empty → 0, else the parsed numeric value. */
const toNumber = (value: string) => (value === '' ? 0 : Number(value));

export function HealthConfigEditor({ serviceId, initialConfig, onUpdate }: HealthConfigEditorProps) {
  const toast = useToast();
  const form = useForm<HealthConfigValues>({
    resolver: zodResolver(healthConfigSchema),
    defaultValues: initialConfig,
    mode: 'onChange',
  });

  // Keep the form in sync if the service's persisted config changes.
  useEffect(() => {
    form.reset(initialConfig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialConfig.healthWaitMs, initialConfig.healthRetries, initialConfig.healthIntervalMs]);

  const config = form.watch();
  const hasChanges = form.formState.isDirty;

  const onSubmit = async (values: HealthConfigValues) => {
    try {
      await updateServiceHealthConfig(serviceId, values as ServiceHealthConfig);
      toast.success('Health config saved');
      form.reset(values);
      onUpdate?.();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save'));
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <FormField
            control={form.control}
            name="healthWaitMs"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs text-muted-foreground">Wait Time (ms)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={0}
                    step={1000}
                    {...field}
                    onChange={(e) => field.onChange(toNumber(e.target.value))}
                  />
                </FormControl>
                <FormDescription>Initial wait after deploy</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="healthRetries"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs text-muted-foreground">Retries</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    {...field}
                    onChange={(e) => field.onChange(toNumber(e.target.value))}
                  />
                </FormControl>
                <FormDescription>Health check attempts</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="healthIntervalMs"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs text-muted-foreground">Interval (ms)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={0}
                    step={1000}
                    {...field}
                    onChange={(e) => field.onChange(toNumber(e.target.value))}
                  />
                </FormControl>
                <FormDescription>Time between retries</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Summary */}
        <div className="rounded bg-muted/50 p-3 text-xs text-muted-foreground">
          <p>During orchestrated deployments, this service will:</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            <li>Wait {((config.healthWaitMs || 0) / 1000).toFixed(1)}s after deployment</li>
            <li>Check health up to {config.healthRetries} times</li>
            <li>Wait {((config.healthIntervalMs || 0) / 1000).toFixed(1)}s between checks</li>
            <li>
              Total max time:{' '}
              {(
                ((config.healthWaitMs || 0) +
                  ((config.healthRetries || 1) - 1) * (config.healthIntervalMs || 0)) /
                1000
              ).toFixed(1)}
              s
            </li>
          </ul>
        </div>

        {hasChanges && (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => form.reset(initialConfig)}>
              Reset
            </Button>
            <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        )}
      </form>
    </Form>
  );
}

// Compact inline display
interface HealthConfigDisplayProps {
  config: {
    healthWaitMs: number;
    healthRetries: number;
    healthIntervalMs: number;
  };
}

export function HealthConfigDisplay({ config }: HealthConfigDisplayProps) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span>Wait: {(config.healthWaitMs / 1000).toFixed(1)}s</span>
      <span>•</span>
      <span>Retries: {config.healthRetries}</span>
      <span>•</span>
      <span>Interval: {(config.healthIntervalMs / 1000).toFixed(1)}s</span>
    </div>
  );
}
