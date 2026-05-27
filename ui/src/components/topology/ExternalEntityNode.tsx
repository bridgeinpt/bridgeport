import { memo, useCallback } from 'react';
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react';

export interface ExternalEntityNodeData {
  label: string;
  externalEntityId: string;
  kind: string;
  iconKey: string | null;
  // Operator-only: triggers deletion through the parent diagram.
  onDelete?: (externalEntityId: string) => void;
}

// Hue map for a few common "kinds" so the diagram visually distinguishes
// external sources at a glance. Unknown kinds get the neutral slate color.
function getKindAccent(kind: string): { border: string; bg: string; text: string } {
  const k = kind.toLowerCase();
  if (k.includes('cloudflare') || k.includes('cdn')) {
    return { border: 'border-orange-500/50', bg: 'bg-orange-500/10', text: 'text-orange-300' };
  }
  if (k.includes('web') || k.includes('browser') || k.includes('client')) {
    return { border: 'border-cyan-500/50', bg: 'bg-cyan-500/10', text: 'text-cyan-300' };
  }
  return { border: 'border-slate-500/50', bg: 'bg-slate-500/10', text: 'text-slate-300' };
}

function ExternalEntityNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as ExternalEntityNodeData;
  const accent = getKindAccent(nodeData.kind);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    nodeData.onDelete?.(nodeData.externalEntityId);
  }, [nodeData]);

  return (
    <div
      className={`relative bg-slate-800 border-2 ${accent.border} ${accent.bg} rounded-full px-4 py-2 min-w-[120px] h-full`}
      title={`External: ${nodeData.kind}`}
    >
      {/* Resizer is opt-in via selection so it doesn't clutter the canvas. */}
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={100}
        minHeight={40}
        color="#3b82f6"
        handleClassName="!w-2 !h-2 !rounded-sm"
      />
      <div className="flex items-center justify-between gap-2 h-full">
        <div className="flex items-center gap-2 min-w-0">
          <svg className={`w-3.5 h-3.5 flex-shrink-0 ${accent.text}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            {/* Globe / external traffic icon */}
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-xs font-medium text-white truncate">{nodeData.label}</span>
        </div>
        {nodeData.onDelete && (
          <button
            onClick={handleDelete}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="p-0.5 text-slate-500 hover:text-red-400 hover:bg-slate-700 rounded flex-shrink-0"
            title="Remove external entity"
            aria-label="Remove external entity"
          >
            <svg className="w-3 h-3 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      {/* 4 handles with stable IDs so the user's chosen anchor is preserved
          across reloads (same shape as ServiceNode / DatabaseNode). */}
      <Handle id="left" type="source" position={Position.Left} className="topology-handle" />
      <Handle id="right" type="source" position={Position.Right} className="topology-handle" />
      <Handle id="top" type="source" position={Position.Top} className="topology-handle" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="topology-handle" />
    </div>
  );
}

export const ExternalEntityNode = memo(ExternalEntityNodeComponent);
