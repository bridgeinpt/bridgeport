import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { useToast } from './Toast';
import {
  getDependencyGraph,
  type DependencyGraphNode,
  type DependencyGraphEdge,
} from '../lib/api';

interface DependencyGraphProps {
  compact?: boolean;
}

export function DependencyGraph({ compact = false }: DependencyGraphProps) {
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const [nodes, setNodes] = useState<DependencyGraphNode[]>([]);
  const [edges, setEdges] = useState<DependencyGraphEdge[]>([]);
  const [deploymentOrder, setDeploymentOrder] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!selectedEnvironment?.id) return;

    setLoading(true);
    getDependencyGraph(selectedEnvironment.id)
      .then(({ nodes, edges, deploymentOrder }) => {
        setNodes(nodes);
        setEdges(edges);
        setDeploymentOrder(deploymentOrder);
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [selectedEnvironment?.id, toast]);

  if (loading) {
    return (
      <div className="animate-pulse">
        <div className="h-48 bg-slate-700 rounded"></div>
      </div>
    );
  }

  // Filter to only show nodes with dependencies
  const connectedNodeIds = new Set<string>();
  edges.forEach((edge) => {
    connectedNodeIds.add(edge.from);
    connectedNodeIds.add(edge.to);
  });

  const connectedNodes = nodes.filter((n) => connectedNodeIds.has(n.id));

  if (connectedNodes.length === 0) {
    return (
      <div className="text-center py-8">
        <GraphIcon className="w-12 h-12 text-slate-500 mx-auto mb-4" />
        <p className="text-slate-400">No service dependencies configured</p>
        <p className="text-slate-500 text-sm mt-1">
          Add dependencies to services to see the deployment order graph
        </p>
      </div>
    );
  }

  // Group nodes by deployment level
  const nodesByLevel: Map<number, DependencyGraphNode[]> = new Map();
  deploymentOrder.forEach((levelIds, index) => {
    const levelNodes = levelIds
      .map((id) => connectedNodes.find((n) => n.id === id))
      .filter(Boolean) as DependencyGraphNode[];
    if (levelNodes.length > 0) {
      nodesByLevel.set(index, levelNodes);
    }
  });

  // Nodes not in any level (shouldn't happen, but handle gracefully)
  const unassignedNodes = connectedNodes.filter(
    (n) => !deploymentOrder.flat().includes(n.id)
  );
  if (unassignedNodes.length > 0) {
    nodesByLevel.set(-1, unassignedNodes);
  }

  return (
    <div className="space-y-4">
      {/* Deployment Order */}
      <div className="flex items-center gap-4 flex-wrap">
        {Array.from(nodesByLevel.entries())
          .sort(([a], [b]) => a - b)
          .map(([level, levelNodes], levelIndex, arr) => (
            <div key={level} className="flex items-center gap-4">
              <div className="flex flex-col gap-2">
                <span className="text-xs text-slate-500 text-center">
                  {level === -1 ? 'Unknown' : `Level ${level + 1}`}
                </span>
                <div className="flex gap-2">
                  {levelNodes.map((node) => (
                    <NodeCard
                      key={node.id}
                      node={node}
                      compact={compact}
                      edges={edges}
                    />
                  ))}
                </div>
              </div>
              {levelIndex < arr.length - 1 && (
                <div className="text-slate-500 text-2xl">→</div>
              )}
            </div>
          ))}
      </div>

      {/* Legend */}
      {!compact && (
        <div className="flex items-center gap-6 pt-4 border-t border-slate-700 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 bg-green-500/20 rounded"></span>
            <span>Healthy</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 bg-red-500/20 rounded"></span>
            <span>Unhealthy</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 bg-slate-500/20 rounded"></span>
            <span>Unknown</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-green-400">→</span>
            <span>Health gate</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-blue-400">→</span>
            <span>Deploy order</span>
          </div>
        </div>
      )}
    </div>
  );
}

function NodeCard({
  node,
  compact,
  edges,
}: {
  node: DependencyGraphNode;
  compact: boolean;
  edges: DependencyGraphEdge[];
}) {
  const statusColor =
    node.healthStatus === 'healthy'
      ? 'border-green-500/50 bg-green-500/10'
      : node.healthStatus === 'unhealthy'
      ? 'border-red-500/50 bg-red-500/10'
      : 'border-slate-600 bg-slate-800/50';

  const outgoingEdges = edges.filter((e) => e.from === node.id);

  return (
    <Link
      to={`/services/${node.id}`}
      className={`block p-3 rounded-lg border ${statusColor} hover:border-primary-500 transition-colors`}
    >
      <div className="flex items-center gap-2">
        <span className="text-white font-medium text-sm">{node.name}</span>
        {node.containerImage && (
          <span className="w-2 h-2 bg-primary-400 rounded-full" title="Container Image" />
        )}
      </div>
      {!compact && (
        <>
          <p className="text-slate-500 text-xs">{node.server}</p>
          {(node.dependencyCount > 0 || node.dependentCount > 0) && (
            <div className="flex gap-2 mt-1 text-xs">
              {node.dependencyCount > 0 && (
                <span className="text-slate-400">↑{node.dependencyCount}</span>
              )}
              {node.dependentCount > 0 && (
                <span className="text-slate-400">↓{node.dependentCount}</span>
              )}
            </div>
          )}
        </>
      )}
      {outgoingEdges.length > 0 && (
        <div className="mt-1 flex gap-1">
          {outgoingEdges.map((edge) => (
            <span
              key={edge.id}
              className={`text-xs ${
                edge.type === 'health_before' ? 'text-green-400' : 'text-blue-400'
              }`}
            >
              →
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}

function GraphIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M7 12h.01M12 12h.01M17 12h.01M7 12a2 2 0 11-4 0 2 2 0 014 0zm5 0a2 2 0 11-4 0 2 2 0 014 0zm5 0a2 2 0 11-4 0 2 2 0 014 0zm-10 0h5m-5 0l2-4m3 4l2 4m-7-4l-2 4m7-4l-2-4"
      />
    </svg>
  );
}
