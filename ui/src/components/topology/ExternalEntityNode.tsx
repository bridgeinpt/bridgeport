import { memo, useCallback } from 'react';
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react';
import { Globe, X } from 'lucide-react';

export interface ExternalEntityNodeData {
  label: string;
  externalEntityId: string;
  kind: string;
  iconKey: string | null;
  // Operator-only: triggers deletion through the parent diagram.
  onDelete?: (externalEntityId: string) => void;
}

// Hue map for a few common "kinds" so the diagram visually distinguishes
// external sources at a glance. Unknown kinds get the neutral muted color.
function getKindAccent(kind: string): { border: string; bg: string; text: string } {
  const k = kind.toLowerCase();
  if (k.includes('cloudflare') || k.includes('cdn')) {
    return { border: 'border-warning/50', bg: 'bg-warning/10', text: 'text-warning' };
  }
  if (k.includes('web') || k.includes('browser') || k.includes('client')) {
    return { border: 'border-info/50', bg: 'bg-info/10', text: 'text-info' };
  }
  return { border: 'border-border', bg: 'bg-muted/40', text: 'text-muted-foreground' };
}

// React Flow's NodeResizer `color` prop is an inline SVG stroke/fill — it can't
// read a Tailwind class, so we pass the resolved sky/primary hex directly.
const RESIZE_HANDLE_COLOR = '#0284c7';

function ExternalEntityNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as ExternalEntityNodeData;
  const accent = getKindAccent(nodeData.kind);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    nodeData.onDelete?.(nodeData.externalEntityId);
  }, [nodeData]);

  return (
    <div
      className={`relative bg-card border-2 ${accent.border} ${accent.bg} rounded-full px-4 py-2 min-w-[120px] h-full`}
      title={`External: ${nodeData.kind}`}
    >
      {/* Resizer is opt-in via selection so it doesn't clutter the canvas. */}
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={100}
        minHeight={40}
        color={RESIZE_HANDLE_COLOR}
        handleClassName="!w-2 !h-2 !rounded-xs"
      />
      <div className="flex items-center justify-between gap-2 h-full">
        <div className="flex items-center gap-2 min-w-0">
          <Globe className={`w-3.5 h-3.5 flex-shrink-0 ${accent.text}`} aria-hidden="true" />
          <span className="text-xs font-medium text-foreground truncate">{nodeData.label}</span>
        </div>
        {nodeData.onDelete && (
          <button
            onClick={handleDelete}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="p-0.5 text-muted-foreground hover:text-destructive hover:bg-muted rounded flex-shrink-0"
            title="Remove external entity"
            aria-label="Remove external entity"
          >
            <X className="w-3 h-3 pointer-events-none" aria-hidden="true" />
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
