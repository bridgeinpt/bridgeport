import { memo, useState, useCallback } from 'react';
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react';

export interface ServerGroupNodeData {
  label: string;
  serverId: string;
  status: string;
  serviceCount: number;
  collapsed: boolean;
  onToggleCollapse: (serverId: string) => void;
  // Lower bounds clamp NodeResizer so the user can't shrink a server group
  // smaller than its currently-laid-out children. Falls back to safe minimums
  // when not provided (e.g. collapsed servers have no children to clamp to).
  minWidth?: number;
  minHeight?: number;
}

function getStatusDotColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'bg-green-500';
    case 'unhealthy':
      return 'bg-red-500';
    default:
      return 'bg-yellow-500';
  }
}

function ServerGroupNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as ServerGroupNodeData;
  const dotColor = getStatusDotColor(nodeData.status);
  const [isHovered, setIsHovered] = useState(false);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    nodeData.onToggleCollapse(nodeData.serverId);
  }, [nodeData]);

  // Clamp to the children's bounding box so resize can't clip child nodes.
  const minWidth = nodeData.minWidth ?? 200;
  const minHeight = nodeData.minHeight ?? 80;

  return (
    <div
      className="bg-slate-800/50 border-2 border-blue-500/40 rounded-lg min-w-[180px] h-full"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Resizer — only visible on selection so it doesn't litter the canvas. */}
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={minWidth}
        minHeight={minHeight}
        color="#3b82f6"
        handleClassName="!w-2 !h-2 !rounded-xs"
      />
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-blue-500/20">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
          </svg>
          <span className="text-xs font-semibold text-white">{nodeData.label}</span>
          <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        </div>
        <div className="flex items-center gap-1.5">
          {nodeData.collapsed && (
            <span className="text-[10px] text-slate-400 bg-slate-700 px-1.5 py-0.5 rounded">
              {nodeData.serviceCount} service{nodeData.serviceCount !== 1 ? 's' : ''}
            </span>
          )}
          <button
            onClick={handleToggle}
            className={`p-0.5 text-slate-500 hover:text-white rounded transition-opacity ${isHovered ? 'opacity-100' : 'opacity-50'}`}
            title={nodeData.collapsed ? 'Expand' : 'Collapse'}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {nodeData.collapsed ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              )}
            </svg>
          </button>
        </div>
      </div>
      {/* Body - React Flow renders children inside the parent node when not collapsed */}
      {!nodeData.collapsed && (
        <div className="p-2 min-h-[40px]">
          {/* Child nodes are positioned by React Flow inside this parent */}
        </div>
      )}
      {/* Handles for aggregated edges only when collapsed. Don't render them
          when expanded — ReactFlow's connectionRadius proximity-snap reads
          handle DOM positions, ignoring CSS opacity/pointer-events, so an
          invisible handle near a child node's edge would silently capture
          drops and route them to a server:<id> source/target that handleConnect
          then rejects. We expose all 4 sides + stable IDs so the user can
          start/end a connection from any anchor and the handle is persisted. */}
      {nodeData.collapsed && (
        <>
          <Handle id="left" type="target" position={Position.Left} className="topology-handle" />
          <Handle id="right" type="source" position={Position.Right} className="topology-handle" />
          <Handle id="top" type="source" position={Position.Top} className="topology-handle" />
          <Handle id="bottom" type="source" position={Position.Bottom} className="topology-handle" />
        </>
      )}
    </div>
  );
}

export const ServerGroupNode = memo(ServerGroupNodeComponent);
