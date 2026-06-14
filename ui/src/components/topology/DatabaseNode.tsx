import { memo, useState, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Database } from 'lucide-react';
import { NodePopover } from './NodePopover';

export interface DatabaseNodeData {
  label: string;
  databaseId: string;
  dbType: string;
  port: number | null;
  status: string; // 'connected' | 'error' | 'unknown'
}

function getStatusDotColor(status: string): string | null {
  switch (status) {
    case 'connected':
    case 'healthy':
      return 'bg-success';
    case 'error':
    case 'unhealthy':
      return 'bg-destructive';
    default:
      return null;
  }
}

function DatabaseNodeComponent({ data }: NodeProps) {
  const nodeData = data as unknown as DatabaseNodeData;
  const [open, setOpen] = useState(false);

  // The PopoverTrigger (this div) handles open/close on click. We only stop the
  // event from bubbling to the React Flow pane (which would deselect nodes).
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const dotColor = getStatusDotColor(nodeData.status);

  return (
    <NodePopover
      open={open}
      onOpenChange={setOpen}
      data={{
        name: nodeData.label,
        type: 'database',
        id: nodeData.databaseId,
        dbType: nodeData.dbType,
        status: nodeData.status,
      }}
    >
      <div
        className="bg-card border-2 border-chart-4/40 rounded-md px-3 py-2 cursor-pointer hover:bg-muted transition-colors min-w-[120px]"
        onClick={handleClick}
      >
        <div className="flex items-center gap-2">
          <Database className="w-3.5 h-3.5 text-chart-4 flex-shrink-0" aria-hidden="true" />
          <span className="text-xs font-medium text-foreground truncate">{nodeData.label}</span>
          {dotColor && <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />}
        </div>
        <div className="flex items-center gap-2 ml-6 mt-0.5">
          <span className="text-[10px] text-muted-foreground bg-muted px-1 rounded">{nodeData.dbType}</span>
          {nodeData.port && (
            <span className="text-[10px] text-muted-foreground font-mono">:{nodeData.port}</span>
          )}
        </div>
        <Handle id="left" type="target" position={Position.Left} className="topology-handle topology-handle-db" />
        <Handle id="right" type="source" position={Position.Right} className="topology-handle topology-handle-db" />
        <Handle id="top" type="source" position={Position.Top} className="topology-handle topology-handle-db" />
        <Handle id="bottom" type="source" position={Position.Bottom} className="topology-handle topology-handle-db" />
      </div>
    </NodePopover>
  );
}

export const DatabaseNode = memo(DatabaseNodeComponent);
