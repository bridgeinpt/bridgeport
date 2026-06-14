import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Link } from 'react-router-dom';
import { Workflow } from 'lucide-react';
import type { DependencyGraphNode, DependencyGraphEdge } from '../lib/api';
import { getContainerStatusColor, getHealthStatusColor } from '../lib/status';

interface DependencyFlowProps {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  deploymentOrder: string[][];
}

// Custom node component for services
function ServiceNode({ data }: { data: DependencyGraphNode & { level: number } }) {
  return (
    <div className="bg-card border border-border rounded-lg p-3 min-w-[180px] shadow-md">
      <Handle type="target" position={Position.Top} className="!bg-primary" />

      <div className="flex items-center justify-between mb-2">
        <Link
          to={`/services/${data.id}`}
          className="text-foreground font-medium hover:text-primary truncate"
        >
          {data.name}
        </Link>
        <div className="flex gap-1">
          <span className={`w-2 h-2 rounded-full ${getContainerStatusColor(data.status).replace('badge-', 'bg-')}`}
                title={`Container: ${data.status}`} />
          <span className={`w-2 h-2 rounded-full ${getHealthStatusColor(data.healthStatus).replace('badge-', 'bg-')}`}
                title={`Health: ${data.healthStatus}`} />
        </div>
      </div>

      <div className="text-xs text-muted-foreground mb-1">
        {data.server}
      </div>

      {data.containerImage && (
        <div className="text-xs text-primary font-mono truncate">
          {data.containerImage.name.split('/').pop()}
        </div>
      )}

      <div className="flex gap-2 mt-2 text-xs">
        {data.dependencyCount > 0 && (
          <span className="text-success" title="Dependencies (services this depends on)">
            ↑{data.dependencyCount}
          </span>
        )}
        {data.dependentCount > 0 && (
          <span className="text-info" title="Dependents (services that depend on this)">
            ↓{data.dependentCount}
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-primary" />
    </div>
  );
}

const nodeTypes: NodeTypes = {
  service: ServiceNode,
};

export function DependencyFlow({ nodes, edges, deploymentOrder }: DependencyFlowProps) {
  // Filter to only show nodes that have dependencies
  const nodesWithDeps = useMemo(() => {
    const nodeIds = new Set<string>();

    // Add all nodes that are part of any edge
    edges.forEach((edge) => {
      nodeIds.add(edge.from);
      nodeIds.add(edge.to);
    });

    return nodes.filter((node) => nodeIds.has(node.id));
  }, [nodes, edges]);

  // Build a map of node levels based on deployment order
  const nodeLevelMap = useMemo(() => {
    const map = new Map<string, number>();
    deploymentOrder.forEach((level, index) => {
      level.forEach((nodeId) => {
        map.set(nodeId, index);
      });
    });
    return map;
  }, [deploymentOrder]);

  // Convert to ReactFlow nodes with layout
  const flowNodes = useMemo((): Node[] => {
    // Group nodes by level
    const levelGroups = new Map<number, DependencyGraphNode[]>();

    nodesWithDeps.forEach((node) => {
      const level = nodeLevelMap.get(node.id) ?? 0;
      if (!levelGroups.has(level)) {
        levelGroups.set(level, []);
      }
      levelGroups.get(level)!.push(node);
    });

    const result: Node[] = [];
    const levelSpacing = 180;
    const nodeSpacing = 220;

    // Sort levels and create nodes
    const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);

    sortedLevels.forEach((level) => {
      const levelNodes = levelGroups.get(level)!;
      const levelWidth = levelNodes.length * nodeSpacing;
      const startX = -levelWidth / 2 + nodeSpacing / 2;

      levelNodes.forEach((node, index) => {
        result.push({
          id: node.id,
          type: 'service',
          position: {
            x: startX + index * nodeSpacing,
            y: level * levelSpacing,
          },
          data: { ...node, level },
        });
      });
    });

    return result;
  }, [nodesWithDeps, nodeLevelMap]);

  // Convert to ReactFlow edges
  const flowEdges = useMemo((): Edge[] => {
    return edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: 'smoothstep',
      animated: edge.type === 'health_before',
      style: {
        stroke: edge.type === 'health_before' ? '#22c55e' : '#3b82f6',
        strokeWidth: 2,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: edge.type === 'health_before' ? '#22c55e' : '#3b82f6',
      },
      label: edge.type === 'health_before' ? 'waits for healthy' : 'deploys after',
      labelStyle: {
        fill: '#94a3b8',
        fontSize: 10,
      },
      labelBgStyle: {
        fill: '#1e293b',
        fillOpacity: 0.8,
      },
    }));
  }, [edges]);

  const [reactNodes, , onNodesChange] = useNodesState(flowNodes);
  const [reactEdges, , onEdgesChange] = useEdgesState(flowEdges);

  // Prevent node dragging since this is view-only
  const onNodeDragStop = useCallback(() => {}, []);

  if (nodesWithDeps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-muted-foreground">
        <Workflow className="w-16 h-16 mb-4 text-muted-foreground/60" aria-hidden="true" />
        <p className="text-lg font-medium mb-1">No Dependencies Configured</p>
        <p className="text-sm text-muted-foreground">
          Add dependencies between services to see the deployment flow
        </p>
      </div>
    );
  }

  return (
    <div className="h-[600px] bg-background rounded-lg border border-border">
      <ReactFlow
        nodes={reactNodes}
        edges={reactEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} />
        <Background color="#334155" gap={20} />
      </ReactFlow>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 bg-card/90 backdrop-blur rounded-lg border border-border p-3 text-xs">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-0.5 bg-success" style={{ position: 'relative' }}>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-0 h-0 border-l-4 border-l-success border-y-2 border-y-transparent" />
            </div>
            <span className="text-muted-foreground">waits for healthy</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-0.5 bg-info" style={{ position: 'relative' }}>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-0 h-0 border-l-4 border-l-info border-y-2 border-y-transparent" />
            </div>
            <span className="text-muted-foreground">deploys after</span>
          </div>
        </div>
      </div>
    </div>
  );
}
