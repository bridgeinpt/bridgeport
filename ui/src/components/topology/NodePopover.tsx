import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';

interface NodePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The node element this popover anchors to (becomes the Radix trigger). */
  children: React.ReactNode;
  data: {
    name: string;
    type: 'service' | 'database';
    id: string;
    image?: string;
    dbType?: string;
    status: string;
    healthStatus?: string;
    ports?: Array<{ host: number | null; container: number; protocol: string }>;
  };
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'running':
    case 'healthy':
      return 'bg-success';
    case 'unhealthy':
    case 'stopped':
    case 'exited':
    case 'dead':
      return 'bg-destructive';
    default:
      return 'bg-warning';
  }
}

function getStatusLabel(status: string, healthStatus?: string): string {
  if (healthStatus && healthStatus !== 'none' && healthStatus !== 'unknown') {
    return healthStatus;
  }
  return status;
}

/**
 * Node detail popover built on shadcn/Radix `Popover`. The node element is
 * passed as `children` and becomes the popover trigger/anchor. Radix handles
 * viewport clamping (B11) via `avoidCollisions` + `collisionPadding`, closes on
 * Escape natively, and closes on outside click/focus — replacing the old
 * fixed-position div with manual mousedown listeners.
 */
export function NodePopover({ open, onOpenChange, children, data }: NodePopoverProps) {
  const displayStatus = getStatusLabel(data.status, data.healthStatus);
  const detailPath = data.type === 'service' ? `/services/${data.id}` : `/databases/${data.id}`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* asChild so the node <div> itself is the anchor — keeps xyflow node
          markup intact while Radix positions the content relative to it. */}
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        avoidCollisions
        collisionPadding={12}
        className="w-auto min-w-[200px] max-w-[280px] p-3 nodrag nopan"
        // Stop the wheel/pointer events from leaking into the React Flow pane.
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-semibold text-foreground mb-1">{data.name}</p>
        {data.image && (
          <p className="text-xs text-muted-foreground font-mono truncate mb-1">{data.image}</p>
        )}
        {data.dbType && (
          <p className="text-xs text-muted-foreground font-mono mb-1">{data.dbType}</p>
        )}
        <div className="flex items-center gap-1.5 mb-1">
          <span className={`w-2 h-2 rounded-full ${getStatusColor(displayStatus)}`} />
          <span className="text-xs text-foreground capitalize">{displayStatus}</span>
        </div>
        {data.ports && data.ports.length > 0 && (
          <div className="mb-1">
            <p className="text-xs text-muted-foreground">Ports:</p>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {data.ports.map((p, i) => (
                <span key={i} className="text-xs font-mono text-foreground bg-muted px-1.5 py-0.5 rounded">
                  {p.host ? `${p.host}:` : ''}{p.container}/{p.protocol}
                </span>
              ))}
            </div>
          </div>
        )}
        <Link
          to={detailPath}
          className="text-xs text-primary hover:underline mt-1 inline-flex items-center gap-1"
        >
          View Details <ArrowRight className="w-3 h-3" aria-hidden="true" />
        </Link>
      </PopoverContent>
    </Popover>
  );
}
