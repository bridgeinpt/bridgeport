import { memo, useCallback, useState } from 'react';
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react';
import { Layers, ChevronDown, ChevronUp, X } from 'lucide-react';

export interface ServerClusterNodeData {
  label: string;
  clusterId: string;
  color: string | null;
  collapsed: boolean;
  serverCount: number;
  // Both callbacks are noop-safe when the viewer lacks permission.
  onToggleCollapse?: (clusterId: string) => void;
  onDelete?: (clusterId: string) => void;
  // Lower bounds clamp NodeResizer so the user can't shrink the cluster below
  // its children's bounding box (otherwise parented servers with extent:'parent'
  // would clip).
  minWidth?: number;
  minHeight?: number;
}

function ServerClusterNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as ServerClusterNodeData;
  const [isHovered, setIsHovered] = useState(false);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    nodeData.onToggleCollapse?.(nodeData.clusterId);
  }, [nodeData]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    nodeData.onDelete?.(nodeData.clusterId);
  }, [nodeData]);

  // Free-form color string from the DB — sanitize lightly. Fallback to amber
  // so clusters are visually distinct from server groups (blue). The custom
  // per-cluster color is an intentional product feature, so it stays an inline
  // style rather than a theme token.
  const accent = nodeData.color && /^#[0-9a-fA-F]{3,8}$/.test(nodeData.color)
    ? nodeData.color
    : '#f59e0b';

  const minWidth = nodeData.minWidth ?? 280;
  const minHeight = nodeData.minHeight ?? 140;

  return (
    <div
      className="bg-card/40 border-2 border-dashed rounded-xl h-full"
      style={{ borderColor: `${accent}66` /* ~40% alpha */ }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={minWidth}
        minHeight={minHeight}
        color={accent}
        handleClassName="!w-2 !h-2 !rounded-xs"
      />
      {/* Header — matches the container's `rounded-xl` corners. */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-t-xl"
        style={{ backgroundColor: `${accent}1a` /* ~10% alpha */ }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-3.5 h-3.5 flex-shrink-0" style={{ color: accent }} aria-hidden="true" />
          <span className="text-xs font-semibold text-foreground truncate">{nodeData.label}</span>
          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {nodeData.serverCount} server{nodeData.serverCount !== 1 ? 's' : ''}
          </span>
        </div>
        <div className={`flex items-center gap-1 transition-opacity ${isHovered || selected ? 'opacity-100' : 'opacity-50'}`}>
          {nodeData.onToggleCollapse && (
            <button
              onClick={handleToggle}
              className="p-0.5 text-muted-foreground hover:text-foreground rounded"
              title={nodeData.collapsed ? 'Expand cluster' : 'Collapse cluster'}
            >
              {nodeData.collapsed ? (
                <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </button>
          )}
          {nodeData.onDelete && (
            <button
              onClick={handleDelete}
              className="p-0.5 text-muted-foreground hover:text-destructive rounded"
              title="Delete cluster (servers become unclustered)"
              aria-label="Delete cluster"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {/* Body: when expanded, React Flow renders parented server nodes here.
          When collapsed, show a compact summary. */}
      {!nodeData.collapsed ? (
        <div className="p-2 min-h-[40px]">
          {/* Parented server-group nodes are positioned by React Flow */}
        </div>
      ) : (
        <div className="px-3 py-2 text-[11px] text-muted-foreground">
          Collapsed. Edges aggregate to this cluster.
        </div>
      )}
      {/* Handles for aggregated edges only when collapsed (same reason as
          ServerGroupNode — proximity-snap with invisible handles would
          mis-route drops). */}
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

export const ServerClusterNode = memo(ServerClusterNodeComponent);
