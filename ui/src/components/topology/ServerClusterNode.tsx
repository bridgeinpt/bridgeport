import { memo, useCallback, useState } from 'react';
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react';

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
  // so clusters are visually distinct from server groups (blue).
  const accent = nodeData.color && /^#[0-9a-fA-F]{3,8}$/.test(nodeData.color)
    ? nodeData.color
    : '#f59e0b';

  const minWidth = nodeData.minWidth ?? 280;
  const minHeight = nodeData.minHeight ?? 140;

  return (
    <div
      className="bg-slate-900/40 border-2 border-dashed rounded-xl h-full"
      style={{ borderColor: `${accent}66` /* ~40% alpha */ }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={minWidth}
        minHeight={minHeight}
        color={accent}
        handleClassName="!w-2 !h-2 !rounded-sm"
      />
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-t-lg"
        style={{ backgroundColor: `${accent}1a` /* ~10% alpha */ }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke={accent}>
            {/* Stack / cluster icon */}
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14-4H5m14 8H5m14 4H5" />
          </svg>
          <span className="text-xs font-semibold text-white truncate">{nodeData.label}</span>
          <span className="text-[10px] text-slate-400 bg-slate-800/80 px-1.5 py-0.5 rounded">
            {nodeData.serverCount} server{nodeData.serverCount !== 1 ? 's' : ''}
          </span>
        </div>
        <div className={`flex items-center gap-1 transition-opacity ${isHovered || selected ? 'opacity-100' : 'opacity-50'}`}>
          {nodeData.onToggleCollapse && (
            <button
              onClick={handleToggle}
              className="p-0.5 text-slate-400 hover:text-white rounded"
              title={nodeData.collapsed ? 'Expand cluster' : 'Collapse cluster'}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                {nodeData.collapsed ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                )}
              </svg>
            </button>
          )}
          {nodeData.onDelete && (
            <button
              onClick={handleDelete}
              className="p-0.5 text-slate-500 hover:text-red-400 rounded"
              title="Delete cluster (servers become unclustered)"
              aria-label="Delete cluster"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
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
        <div className="px-3 py-2 text-[11px] text-slate-400">
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
