import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  createConnection,
  type ServerWithServices,
  type Database,
  type ServiceConnection,
  type ExternalEntity,
} from '../../lib/api';
import { getErrorMessage } from '@/lib/helpers';
import { toast } from '../Toast';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

interface AddConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  servers: ServerWithServices[];
  databases: Database[];
  externalEntities?: ExternalEntity[];
  onConnectionCreated: (connection: ServiceConnection) => void;
}

interface NodeOption {
  type: 'service' | 'database' | 'external';
  id: string;
  label: string;
  group: string;
}

const PROTOCOLS = ['tcp', 'http', 'grpc', 'custom'] as const;

// Radix Select disallows empty-string item values, so "None" protocol is
// represented by this sentinel and mapped back to `null` on submit.
const PROTOCOL_NONE = 'none';

const connectionSchema = z.object({
  sourceKey: z.string().min(1, 'Source is required'),
  targetKey: z.string().min(1, 'Target is required'),
  // Kept as a string (matches the number <input>); validated/parsed on submit.
  port: z
    .string()
    .refine(
      (val) => {
        if (!val) return true;
        const n = parseInt(val, 10);
        return Number.isFinite(n) && n > 0 && n <= 65535;
      },
      { message: 'Port must be a number between 1 and 65535' }
    ),
  protocol: z.string(),
  label: z.string(),
  direction: z.enum(['forward', 'none']),
});

type ConnectionValues = z.infer<typeof connectionSchema>;

const DEFAULT_VALUES: ConnectionValues = {
  sourceKey: '',
  targetKey: '',
  port: '',
  protocol: PROTOCOL_NONE,
  label: '',
  direction: 'forward',
};

const typeLabel = (type: NodeOption['type']) =>
  type === 'service' ? 'Service' : type === 'database' ? 'Database' : 'External';

export function AddConnectionModal({
  isOpen,
  onClose,
  environmentId,
  servers,
  databases,
  externalEntities = [],
  onConnectionCreated,
}: AddConnectionModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<ConnectionValues>({
    resolver: zodResolver(connectionSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const sourceKey = form.watch('sourceKey');

  // Reset form + error whenever the modal opens.
  useEffect(() => {
    if (isOpen) {
      form.reset(DEFAULT_VALUES);
      setServerError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Build flat node list grouped by server.
  const nodeOptions = useMemo<NodeOption[]>(() => {
    const options: NodeOption[] = [];
    for (const server of servers) {
      for (const service of server.services) {
        options.push({
          type: 'service',
          id: service.id,
          label: service.name,
          group: `Server: ${server.name}`,
        });
      }
    }
    for (const db of databases) {
      const serverName = servers.find((s) => s.id === db.serverId)?.name;
      options.push({
        type: 'database',
        id: db.id,
        label: db.name,
        group: serverName ? `Server: ${serverName}` : 'External',
      });
    }
    for (const ext of externalEntities) {
      options.push({
        type: 'external',
        id: ext.id,
        label: ext.label,
        group: 'External Entity',
      });
    }
    return options;
  }, [servers, databases, externalEntities]);

  const targetOptions = useMemo(() => {
    return nodeOptions.filter((n) => `${n.type}:${n.id}` !== sourceKey);
  }, [nodeOptions, sourceKey]);

  const handleClose = () => {
    onClose();
  };

  const onSubmit = async (values: ConnectionValues) => {
    const [sourceType, sourceId] = values.sourceKey.split(':') as [
      'service' | 'database' | 'external',
      string,
    ];
    const [targetType, targetId] = values.targetKey.split(':') as [
      'service' | 'database' | 'external',
      string,
    ];

    // Parse port; schema already rejected out-of-range/NaN values.
    // JSON.stringify(NaN) is "null", which would silently drop user input.
    const parsedPort: number | null = values.port ? parseInt(values.port, 10) : null;

    setServerError(null);

    try {
      const created = await createConnection({
        environmentId,
        sourceType,
        sourceId,
        targetType,
        targetId,
        port: parsedPort,
        protocol: values.protocol === PROTOCOL_NONE ? null : values.protocol,
        label: values.label || null,
        direction: values.direction,
      });
      onConnectionCreated(created);
      toast.success('Connection created');
      handleClose();
    } catch (err) {
      setServerError(getErrorMessage(err, 'Failed to create connection'));
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Connection</DialogTitle>
          <DialogDescription>
            Link a service, database, or external entity to another node.
          </DialogDescription>
        </DialogHeader>

        {serverError && (
          <Alert variant="destructive">
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Source */}
            <FormField
              control={form.control}
              name="sourceKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Source</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value);
                      // Clear target if it now matches the new source.
                      if (form.getValues('targetKey') === value) {
                        form.setValue('targetKey', '');
                      }
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select source..." />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {nodeOptions.map((opt) => (
                        <SelectItem
                          key={`${opt.type}:${opt.id}`}
                          value={`${opt.type}:${opt.id}`}
                        >
                          [{typeLabel(opt.type)}] {opt.label} ({opt.group})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Target */}
            <FormField
              control={form.control}
              name="targetKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Target</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select target..." />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {targetOptions.map((opt) => (
                        <SelectItem
                          key={`${opt.type}:${opt.id}`}
                          value={`${opt.type}:${opt.id}`}
                        >
                          [{typeLabel(opt.type)}] {opt.label} ({opt.group})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Port & Protocol */}
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="port"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Port</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="e.g. 5432"
                        min={1}
                        max={65535}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="protocol"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Protocol</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={PROTOCOL_NONE}>None</SelectItem>
                        {PROTOCOLS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p.toUpperCase()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Label */}
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Label</FormLabel>
                  <FormControl>
                    <Input type="text" placeholder="e.g. Primary DB" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Direction */}
            <FormField
              control={form.control}
              name="direction"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Direction</FormLabel>
                  <FormControl>
                    <RadioGroup
                      value={field.value}
                      onValueChange={field.onChange}
                      className="flex gap-4"
                    >
                      <Label
                        htmlFor="direction-forward"
                        className="flex cursor-pointer items-center gap-2 font-normal text-foreground"
                      >
                        <RadioGroupItem id="direction-forward" value="forward" />
                        Directed (source &rarr; target)
                      </Label>
                      <Label
                        htmlFor="direction-none"
                        className="flex cursor-pointer items-center gap-2 font-normal text-foreground"
                      >
                        <RadioGroupItem id="direction-none" value="none" />
                        Undirected
                      </Label>
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={form.formState.isSubmitting || !sourceKey || !form.watch('targetKey')}
              >
                {form.formState.isSubmitting ? 'Creating...' : 'Add Connection'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
