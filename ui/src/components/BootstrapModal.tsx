import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import {
  runServerBootstrap,
  type BootstrapComponents,
  type BootstrapStatus,
} from '../lib/api';
import { useEventSource } from '../lib/useEventSource';
import { useToast } from './Toast';
import { getErrorMessage } from '@/lib/helpers';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

interface BootstrapProgressEvent {
  serverId: string;
  environmentId: string;
  component?: 'docker' | 'sysctl' | 'agent' | 'swap' | 'distro' | 'preflight';
  phase: 'start' | 'step' | 'done' | 'error';
  level: 'info' | 'error';
  line: string;
}

interface BootstrapModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverId: string;
  status: BootstrapStatus | null;
  onComplete?: () => void;
}

interface LogLine {
  text: string;
  level: 'info' | 'error';
  ts: number;
}

const DEFAULT_SWAP_MB = 2048;

const COMPONENT_KEYS = ['docker', 'sysctl', 'agent', 'swap'] as const;

const COMPONENT_DESCRIPTIONS: Record<(typeof COMPONENT_KEYS)[number], string> = {
  docker: 'Install Docker Engine + Compose plugin via get.docker.com',
  sysctl: 'Write /etc/sysctl.d/99-bridgeport.conf (vm.swappiness, fs.file-max)',
  agent: 'Deploy the BridgePort monitoring agent',
  swap: 'Create /swapfile and persist via /etc/fstab',
};

const bootstrapSchema = z
  .object({
    docker: z.boolean(),
    sysctl: z.boolean(),
    agent: z.boolean(),
    swap: z.boolean(),
    swapSizeMb: z.number().int().min(128).max(65536),
  })
  .refine((data) => data.docker || data.sysctl || data.agent || data.swap, {
    message: 'Select at least one component',
    path: ['docker'],
  })
  .refine((data) => !data.swap || (data.swapSizeMb >= 128 && data.swapSizeMb <= 65536), {
    message: 'Swap size must be between 128 and 65536 MB',
    path: ['swapSizeMb'],
  });

type BootstrapValues = z.infer<typeof bootstrapSchema>;

export function BootstrapModal({
  isOpen,
  onClose,
  serverId,
  status,
  onComplete,
}: BootstrapModalProps) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  const form = useForm<BootstrapValues>({
    resolver: zodResolver(bootstrapSchema),
    mode: 'onChange',
    defaultValues: {
      docker: true,
      sysctl: true,
      agent: true,
      swap: false,
      swapSizeMb: DEFAULT_SWAP_MB,
    },
  });

  const swapSelected = form.watch('swap');

  // Reset state when the modal opens fresh.
  useEffect(() => {
    if (isOpen) {
      setLogs([]);
      setFinished(false);
      setRunning(false);
      form.reset({
        docker: true,
        sysctl: true,
        agent: true,
        swap: false,
        swapSizeMb: DEFAULT_SWAP_MB,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Subscribe to bootstrap_progress SSE events scoped to this server.
  useEventSource('bootstrap_progress', (raw) => {
    const ev = raw as BootstrapProgressEvent;
    if (ev.serverId !== serverId) return;
    setLogs((prev) => [...prev, { text: ev.line, level: ev.level, ts: Date.now() }]);
    if (ev.phase === 'done' && !ev.component) {
      setRunning(false);
      setFinished(true);
      onComplete?.();
    } else if (ev.phase === 'error' && !ev.component) {
      setRunning(false);
      setFinished(true);
    }
  });

  // Auto-scroll log pane to bottom as new lines arrive.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const sudoOk = status?.sudo?.ok ?? false;
  const distroSupported = status?.distro?.supported ?? false;
  const distroRaw = status?.distro?.raw || status?.bootstrapDistro || 'unknown';

  const onSubmit = async (values: BootstrapValues) => {
    setRunning(true);
    setFinished(false);
    setLogs([]);
    const components: BootstrapComponents = {
      docker: values.docker,
      sysctl: values.sysctl,
      agent: values.agent,
      swap: values.swap,
    };
    try {
      await runServerBootstrap(serverId, {
        components,
        swapSizeMb: values.swap ? values.swapSizeMb : undefined,
      });
      toast.success('Bootstrap started');
    } catch (err) {
      const msg = getErrorMessage(err, 'Bootstrap failed to start');
      toast.error(msg);
      setRunning(false);
      setLogs((prev) => [...prev, { text: msg, level: 'error', ts: Date.now() }]);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle>Bootstrap Server</DialogTitle>
          <DialogDescription>
            Install Docker, configure sysctl, deploy the agent, and optionally add swap
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Sudo / distro banner */}
            <Alert variant={sudoOk && distroSupported ? 'default' : 'warning'}>
              {sudoOk && distroSupported ? <CheckCircle2 /> : <TriangleAlert />}
              <AlertDescription>
                <div className="flex flex-col gap-1">
                  <div>
                    <span className="text-muted-foreground">Distro:</span>{' '}
                    <span className="font-mono">{distroRaw}</span>{' '}
                    {distroSupported ? (
                      <span className="text-success">(supported)</span>
                    ) : (
                      <span className="text-warning">(unsupported — Ubuntu/Debian only)</span>
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Passwordless sudo:</span>{' '}
                    {sudoOk ? (
                      <span className="text-success">OK</span>
                    ) : (
                      <span className="text-warning">
                        not detected{status?.sudo?.error ? ` — ${status.sudo.error}` : ''}
                      </span>
                    )}
                  </div>
                  {!sudoOk && (
                    <p className="mt-1 text-xs">
                      Bootstrap requires passwordless sudo (NOPASSWD) or root SSH access.
                    </p>
                  )}
                </div>
              </AlertDescription>
            </Alert>

            {/* Component selection */}
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Components</p>
              <div className="grid grid-cols-2 gap-3">
                {COMPONENT_KEYS.map((key) => (
                  <FormField
                    key={key}
                    control={form.control}
                    name={key}
                    render={({ field }) => (
                      <FormItem
                        className={`flex flex-row items-start gap-3 rounded-lg border p-3 ${
                          field.value ? 'border-primary/50 bg-primary/5' : 'border-input bg-muted/30'
                        } ${running ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                      >
                        <FormControl>
                          <Checkbox
                            className="mt-0.5"
                            checked={Boolean(field.value)}
                            disabled={running}
                            onCheckedChange={(checked) => field.onChange(checked === true)}
                          />
                        </FormControl>
                        <div className="flex-1 space-y-0.5">
                          <FormLabel className="font-medium capitalize text-foreground">
                            {key}
                          </FormLabel>
                          <FormDescription className="text-xs">
                            {COMPONENT_DESCRIPTIONS[key]}
                          </FormDescription>
                        </div>
                      </FormItem>
                    )}
                  />
                ))}
              </div>
              {/* Surface the "at least one component" rule (attached to `docker`). */}
              <FormField
                control={form.control}
                name="docker"
                render={() => <FormMessage />}
              />
            </div>

            {/* Swap size input */}
            {swapSelected && (
              <FormField
                control={form.control}
                name="swapSizeMb"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Swap size (MB)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={128}
                        max={65536}
                        step={128}
                        disabled={running}
                        className="w-40 font-mono"
                        {...field}
                        onChange={(e) =>
                          field.onChange(e.target.value === '' ? 0 : parseInt(e.target.value, 10))
                        }
                      />
                    </FormControl>
                    <FormDescription>Range: 128 - 65536 MB.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Log pane */}
            {(running || logs.length > 0) && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Progress</p>
                <div className="max-h-72 overflow-y-auto rounded-lg border bg-background p-3 font-mono text-xs">
                  {logs.length === 0 ? (
                    <p className="text-muted-foreground">Waiting for output...</p>
                  ) : (
                    logs.map((l, i) => (
                      <div
                        key={i}
                        className={l.level === 'error' ? 'text-destructive' : 'text-foreground'}
                      >
                        {l.text}
                      </div>
                    ))
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>
            )}

            {/* Footer actions */}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={running}>
                {finished ? 'Close' : 'Cancel'}
              </Button>
              {!finished && (
                <Button
                  type="submit"
                  disabled={running || !sudoOk || !distroSupported}
                >
                  {running ? 'Running...' : 'Start Bootstrap'}
                </Button>
              )}
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default BootstrapModal;
