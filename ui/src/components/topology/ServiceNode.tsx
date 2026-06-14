import { memo, useState, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodePopover } from './NodePopover';

export interface ServiceNodeData {
  label: string;
  serviceId: string;
  status: string;
  healthStatus: string;
  containerStatus: string;
  image: string;
  ports: Array<{ host: number | null; container: number; protocol: string }>;
  primaryPort: number | null;
}

function getStatusBorderColor(status: string, healthStatus: string): string {
  if (healthStatus === 'healthy' || status === 'running' || status === 'healthy') {
    return 'border-success/50';
  }
  if (status === 'stopped' || status === 'exited' || status === 'dead' || healthStatus === 'unhealthy') {
    return 'border-destructive/50';
  }
  if (status === 'unknown' || healthStatus === 'unknown') {
    return 'border-warning/50';
  }
  return 'border-border';
}

function getStatusDotColor(status: string, healthStatus: string): string {
  if (healthStatus === 'healthy' || status === 'running' || status === 'healthy') {
    return 'bg-success';
  }
  if (status === 'stopped' || status === 'exited' || status === 'dead' || healthStatus === 'unhealthy') {
    return 'bg-destructive';
  }
  if (status === 'unknown' || healthStatus === 'unknown') {
    return 'bg-warning';
  }
  return 'bg-muted-foreground';
}

function ServiceNodeComponent({ data }: NodeProps) {
  const nodeData = data as unknown as ServiceNodeData;
  const [open, setOpen] = useState(false);

  // The PopoverTrigger (this div) handles open/close on click. We only stop the
  // event from bubbling to the React Flow pane (which would deselect nodes).
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const borderColor = getStatusBorderColor(nodeData.status, nodeData.healthStatus);
  const dotColor = getStatusDotColor(nodeData.status, nodeData.healthStatus);

  return (
    <NodePopover
      open={open}
      onOpenChange={setOpen}
      data={{
        name: nodeData.label,
        type: 'service',
        id: nodeData.serviceId,
        image: nodeData.image,
        status: nodeData.containerStatus || nodeData.status,
        healthStatus: nodeData.healthStatus,
        ports: nodeData.ports,
      }}
    >
      <div
        className={`bg-card border-2 ${borderColor} rounded-md px-3 py-2 cursor-pointer hover:bg-muted transition-colors min-w-[120px]`}
        onClick={handleClick}
      >
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
          <span className="text-xs font-medium text-foreground truncate">{nodeData.label}</span>
        </div>
        {nodeData.primaryPort && (
          <span className="text-[10px] text-muted-foreground font-mono ml-4">:{nodeData.primaryPort}</span>
        )}
        <Handle id="left" type="target" position={Position.Left} className="topology-handle" />
        <Handle id="right" type="source" position={Position.Right} className="topology-handle" />
        <Handle id="top" type="source" position={Position.Top} className="topology-handle" />
        <Handle id="bottom" type="source" position={Position.Bottom} className="topology-handle" />
      </div>
    </NodePopover>
  );
}

export const ServiceNode = memo(ServiceNodeComponent);
