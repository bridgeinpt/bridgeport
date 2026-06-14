import { memo, useState, useCallback } from 'react';
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react';
import { Server, ChevronDown, ChevronUp } from 'lucide-react';

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

// React Flow's NodeResizer `color` prop is an inline SVG color — it can't read
// a Tailwind class, so we pass the resolved sky/primary hex directly.
const RESIZE_HANDLE_COLOR = '#0284c7';

function getStatusDotColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'bg-success';
    case 'unhealthy':
      return 'bg-destructive';
    default:
      return 'bg-warning';
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
      className="bg-card/50 border-2 border-info/40 rounded-lg min-w-[180px] h-full"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Resizer — only visible on selection so it doesn't litter the canvas. */}
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={minWidth}
        minHeight={minHeight}
        color={RESIZE_HANDLE_COLOR}
        handleClassName="!w-2 !h-2 !rounded-xs"
      />
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-info/20">
        <div className="flex items-center gap-2">
          <Server className="w-3.5 h-3.5 text-info" aria-hidden="true" />
          <span className="text-xs font-semibold text-foreground">{nodeData.label}</span>
          <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        </div>
        <div className="flex items-center gap-1.5">
          {nodeData.collapsed && (
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {nodeData.serviceCount} service{nodeData.serviceCount !== 1 ? 's' : ''}
            </span>
          )}
          <button
            onClick={handleToggle}
            className={`p-0.5 text-muted-foreground hover:text-foreground rounded transition-opacity ${isHovered ? 'opacity-100' : 'opacity-50'}`}
            title={nodeData.collapsed ? 'Expand' : 'Collapse'}
          >
            {nodeData.collapsed ? (
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
            ) : (
              <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
            )}
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
