import { memo, useState, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodePopover } from './NodePopover';

export interface DatabaseNodeData {
  label: string;
  databaseId: string;
  dbType: string;
  port: number | null;
  status: string; // 'connected' | 'error' | 'unknown'
}

function getStatusDotColor(status: string): string {
  switch (status) {
    case 'connected':
    case 'healthy':
      return 'bg-green-500';
    case 'error':
    case 'unhealthy':
      return 'bg-red-500';
    default:
      return 'bg-yellow-500';
  }
}

function DatabaseNodeComponent({ data }: NodeProps) {
  const nodeData = data as unknown as DatabaseNodeData;
  const [popover, setPopover] = useState<{ x: number; y: number } | null>(null);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (popover) {
      setPopover(null);
    } else {
      setPopover({ x: e.clientX + 10, y: e.clientY - 10 });
    }
  }, [popover]);

  const dotColor = getStatusDotColor(nodeData.status);

  return (
    <>
      <div
        className="bg-slate-800 border-2 border-purple-500/40 rounded-md px-3 py-2 cursor-pointer hover:bg-slate-750 transition-colors min-w-[120px]"
        onClick={handleClick}
      >
        <div className="flex items-center gap-2">
          {/* Database cylinder icon */}
          <svg className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
          </svg>
          <span className="text-xs font-medium text-white truncate">{nodeData.label}</span>
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
        </div>
        <div className="flex items-center gap-2 ml-5.5 mt-0.5">
          <span className="text-[10px] text-slate-500 bg-slate-700/50 px-1 rounded">{nodeData.dbType}</span>
          {nodeData.port && (
            <span className="text-[10px] text-slate-400 font-mono">:{nodeData.port}</span>
          )}
        </div>
        <Handle type="target" position={Position.Left} className="!bg-purple-400 !w-2 !h-2 !border-slate-700" />
        <Handle type="source" position={Position.Right} className="!bg-purple-400 !w-2 !h-2 !border-slate-700" />
      </div>
      <NodePopover
        isOpen={popover !== null}
        onClose={() => setPopover(null)}
        position={popover || { x: 0, y: 0 }}
        data={{
          name: nodeData.label,
          type: 'database',
          id: nodeData.databaseId,
          dbType: nodeData.dbType,
          status: nodeData.status,
        }}
      />
    </>
  );
}

export const DatabaseNode = memo(DatabaseNodeComponent);
