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
    return 'border-green-500/50';
  }
  if (status === 'stopped' || status === 'exited' || status === 'dead' || healthStatus === 'unhealthy') {
    return 'border-red-500/50';
  }
  if (status === 'unknown' || healthStatus === 'unknown') {
    return 'border-yellow-500/50';
  }
  return 'border-slate-600';
}

function getStatusDotColor(status: string, healthStatus: string): string {
  if (healthStatus === 'healthy' || status === 'running' || status === 'healthy') {
    return 'bg-green-500';
  }
  if (status === 'stopped' || status === 'exited' || status === 'dead' || healthStatus === 'unhealthy') {
    return 'bg-red-500';
  }
  if (status === 'unknown' || healthStatus === 'unknown') {
    return 'bg-yellow-500';
  }
  return 'bg-slate-500';
}

function ServiceNodeComponent({ data }: NodeProps) {
  const nodeData = data as unknown as ServiceNodeData;
  const [popover, setPopover] = useState<{ x: number; y: number } | null>(null);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (popover) {
      setPopover(null);
    } else {
      setPopover({ x: e.clientX + 10, y: e.clientY - 10 });
    }
  }, [popover]);

  const borderColor = getStatusBorderColor(nodeData.status, nodeData.healthStatus);
  const dotColor = getStatusDotColor(nodeData.status, nodeData.healthStatus);

  return (
    <>
      <div
        className={`bg-slate-800 border-2 ${borderColor} rounded-md px-3 py-2 cursor-pointer hover:bg-slate-750 transition-colors min-w-[120px]`}
        onClick={handleClick}
      >
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
          <span className="text-xs font-medium text-white truncate">{nodeData.label}</span>
        </div>
        {nodeData.primaryPort && (
          <span className="text-[10px] text-slate-400 font-mono ml-4">:{nodeData.primaryPort}</span>
        )}
        <Handle type="target" position={Position.Left} className="!bg-slate-500 !w-2 !h-2 !border-slate-700" />
        <Handle type="source" position={Position.Right} className="!bg-slate-500 !w-2 !h-2 !border-slate-700" />
      </div>
      <NodePopover
        isOpen={popover !== null}
        onClose={() => setPopover(null)}
        position={popover || { x: 0, y: 0 }}
        data={{
          name: nodeData.label,
          type: 'service',
          id: nodeData.serviceId,
          image: nodeData.image,
          status: nodeData.containerStatus || nodeData.status,
          healthStatus: nodeData.healthStatus,
          ports: nodeData.ports,
        }}
      />
    </>
  );
}

export const ServiceNode = memo(ServiceNodeComponent);
