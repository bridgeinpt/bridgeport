import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ConnectionMode,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type EdgeChange,
  type NodeTypes,
  type EdgeTypes,
  ReactFlowProvider,
  useReactFlow,
  MarkerType,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
  type OnNodeDrag,
  type OnConnect,
  type OnConnectEnd,
  type OnEdgesChange,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ServerGroupNode } from './ServerGroupNode';
import { ServiceNode, type ServiceNodeData } from './ServiceNode';
import { DatabaseNode, type DatabaseNodeData } from './DatabaseNode';
import { ExternalEntityNode, type ExternalEntityNodeData } from './ExternalEntityNode';
import { ServerClusterNode, type ServerClusterNodeData } from './ServerClusterNode';
import { AddConnectionModal } from './AddConnectionModal';
import type {
  ServerWithServices,
  Database,
  UserRole,
  ExposedPort,
  ServiceConnection,
  DiagramLayoutPositions,
  ExternalEntity,
  ServerCluster,
  ConnectionEndpointType,
} from '../../lib/api';
import {
  listConnections,
  createConnection,
  deleteConnection,
  getDiagramLayout,
  saveDiagramLayout,
  exportDiagramMermaid,
  listExternalEntities,
  createExternalEntity,
  updateExternalEntity,
  deleteExternalEntity,
  listServerClusters,
  createServerCluster,
  updateServerCluster,
  deleteServerCluster,
} from '../../lib/api';
import { inferConnections, mergeConnections, aggregateCollapsedEdges, type TopologyEdge } from '../../lib/topology';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '../Toast';
import { toPng } from 'html-to-image';
import { safeJsonParse, getErrorMessage } from '../../lib/helpers';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Download,
  Maximize2,
  Minimize2,
  Plus,
  Globe,
  Layers,
  Search,
  ChevronDown,
  ChevronUp,
  X,
  ArrowRight,
  Trash2,
  Link2,
  Network,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function downloadFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface TopologyDiagramProps {
  servers: ServerWithServices[];
  databases: Database[];
  environmentId: string;
  userRole: UserRole;
}

type DiagramMode = 'compact' | 'expanded' | 'fullscreen';

const nodeTypes: NodeTypes = {
  serverGroup: ServerGroupNode,
  serviceNode: ServiceNode,
  databaseNode: DatabaseNode,
  externalEntity: ExternalEntityNode,
  serverCluster: ServerClusterNode,
};

// Prevent React Flow from intercepting events on interactive edge label elements
const stopAllPropagation = (e: React.MouseEvent | React.PointerEvent) => {
  e.stopPropagation();
};

interface TopologyEdgeData {
  edgeType?: 'auto' | 'manual';
  label?: string | null;
  port?: number | null;
  protocol?: string | null;
  manualId?: string;
  onDelete?: (connectionId: string) => void;
  aggregated?: boolean;
  [key: string]: unknown;
}

// Custom edge component with colored rendering
function TopologyEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  selected,
}: EdgeProps) {
  const edgeData = data as TopologyEdgeData | undefined;
  const isAuto = edgeData?.edgeType === 'auto';
  const strokeColor = isAuto ? '#60a5fa' : '#4ade80';
  const strokeWidth = selected ? 3 : 2;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  const showLabel = Boolean(edgeData?.label) || Boolean(edgeData?.manualId);

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ stroke: strokeColor, strokeWidth }} markerEnd={markerEnd} />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className="absolute flex items-center gap-1 text-[10px] bg-card border border-border px-1.5 py-0.5 rounded text-foreground pointer-events-auto nopan nodrag"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            title={[edgeData?.port && `Port: ${edgeData.port}`, edgeData?.protocol && `Protocol: ${edgeData.protocol}`, edgeData?.label].filter(Boolean).join(' | ')}
            onPointerDown={stopAllPropagation}
            onMouseDown={stopAllPropagation}
          >
            {edgeData?.label && <span>{edgeData.label}</span>}
            {edgeData?.manualId && edgeData?.onDelete && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  edgeData.onDelete?.(edgeData.manualId!);
                }}
                onPointerDown={stopAllPropagation}
                onMouseDown={stopAllPropagation}
                className="p-0.5 text-muted-foreground hover:text-destructive hover:bg-muted rounded ml-0.5 cursor-pointer"
                title="Delete connection"
                aria-label="Delete connection"
              >
                <X className="w-3.5 h-3.5 pointer-events-none" aria-hidden="true" />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes: EdgeTypes = {
  topology: TopologyEdgeComponent,
};

// Layout constants
const SERVER_PADDING = 20;
const NODE_WIDTH = 160;
const NODE_HEIGHT = 44;
const NODE_GAP = 12;
const SERVER_HEADER_HEIGHT = 40;
const SERVER_GAP = 40;
const DATABASE_STANDALONE_X_OFFSET = 50;

function parseExposedPorts(portsJson: string | null | undefined): ExposedPort[] {
  return safeJsonParse(portsJson, [] as ExposedPort[]);
}

interface BuildResult {
  nodes: Node[];
  serviceToServer: Map<string, string>;
  databaseToServer: Map<string, string>;
  serverToCluster: Map<string, string>;
}

// Sidecar parameters bundle so the function signature stays manageable as
// the diagram grew to support external entities and clusters.
interface BuildNodesContext {
  servers: ServerWithServices[];
  databases: Database[];
  externalEntities: ExternalEntity[];
  serverClusters: ServerCluster[];
  collapsedServers: Set<string>;
  collapsedClusters: Set<string>;
  savedPositions: DiagramLayoutPositions | null;
  onToggleCollapse: (serverId: string) => void;
  onToggleClusterCollapse?: (clusterId: string) => void;
  onDeleteCluster?: (clusterId: string) => void;
  onDeleteExternalEntity?: (externalEntityId: string) => void;
}

function buildNodes(ctx: BuildNodesContext): BuildResult {
  const {
    servers,
    databases,
    externalEntities,
    serverClusters,
    collapsedServers,
    collapsedClusters,
    savedPositions,
    onToggleCollapse,
    onToggleClusterCollapse,
    onDeleteCluster,
    onDeleteExternalEntity,
  } = ctx;
  const nodes: Node[] = [];
  const serviceToServer = new Map<string, string>();
  const databaseToServer = new Map<string, string>();
  const serverToCluster = new Map<string, string>();
  let serverX = 0;

  const placedDatabaseIds = new Set<string>();

  // --- Cluster nodes first, so server groups can reference them as parents.
  // We track per-cluster cursor positions for laying out parented servers
  // inside the cluster body.
  const clustersById = new Map<string, ServerCluster>();
  for (const c of serverClusters) {
    clustersById.set(c.id, c);
    serverToCluster.set(c.id, c.id); // placeholder; replaced below per-server
  }
  // serverToCluster is populated from Server.clusterId as we iterate servers.
  serverToCluster.clear();
  const clusterCursor = new Map<
    string,
    { x: number; y: number; maxRowHeight: number; width: number }
  >();
  for (const cluster of serverClusters) {
    const clusterNodeId = `cluster:${cluster.id}`;
    const isCollapsed = collapsedClusters.has(cluster.id);
    const savedPos = savedPositions?.[clusterNodeId];
    const widthFromSaved = savedPos?.width ?? cluster.width ?? undefined;
    const heightFromSaved = savedPos?.height ?? cluster.height ?? undefined;
    const effectiveClusterWidth = widthFromSaved ?? 600;
    const childServers = servers.filter((s) => s.clusterId === cluster.id);
    const data: ServerClusterNodeData = {
      label: cluster.name,
      clusterId: cluster.id,
      color: cluster.color,
      collapsed: isCollapsed,
      serverCount: childServers.length,
      onToggleCollapse: onToggleClusterCollapse,
      onDelete: onDeleteCluster,
    };
    nodes.push({
      id: clusterNodeId,
      type: 'serverCluster',
      position: savedPos ? { x: savedPos.x, y: savedPos.y } : { x: cluster.x, y: cluster.y },
      data: data as unknown as Record<string, unknown>,
      style: {
        width: effectiveClusterWidth,
        height: heightFromSaved ?? (isCollapsed ? 80 : 260),
        // Clusters render below all other nodes so children float above the
        // dashed border.
        zIndex: 0,
      },
    });
    clusterCursor.set(cluster.id, {
      x: 12,
      y: SERVER_HEADER_HEIGHT + 4,
      maxRowHeight: 0,
      width: effectiveClusterWidth,
    });
  }

  for (const server of servers) {
    const isCollapsed = collapsedServers.has(server.id);
    const inCluster = server.clusterId && clustersById.has(server.clusterId) ? server.clusterId : null;
    if (inCluster) serverToCluster.set(server.id, inCluster);
    const parentClusterCollapsed = inCluster ? collapsedClusters.has(inCluster) : false;
    // If the parent cluster is collapsed, skip rendering child servers — the
    // cluster node is the visual stand-in and edges aggregate to it.
    if (parentClusterCollapsed) {
      for (const service of server.services) serviceToServer.set(service.id, server.id);
      const serverDatabases = databases.filter((db) => db.serverId === server.id);
      for (const db of serverDatabases) {
        placedDatabaseIds.add(db.id);
        databaseToServer.set(db.id, server.id);
      }
      continue;
    }
    const serverDatabases = databases.filter((db) => db.serverId === server.id);
    serverDatabases.forEach((db) => placedDatabaseIds.add(db.id));

    for (const service of server.services) {
      serviceToServer.set(service.id, server.id);
    }
    for (const db of serverDatabases) {
      databaseToServer.set(db.id, server.id);
    }

    const childCount = isCollapsed ? 0 : server.services.length + serverDatabases.length;
    const columns = Math.max(1, Math.min(3, Math.ceil(childCount / 3)));
    const rows = Math.ceil(childCount / columns);
    const computedWidth = Math.max(
      200,
      columns * (NODE_WIDTH + NODE_GAP) + SERVER_PADDING * 2 - NODE_GAP
    );
    const computedHeight = isCollapsed
      ? SERVER_HEADER_HEIGHT + 10
      : SERVER_HEADER_HEIGHT + rows * (NODE_HEIGHT + NODE_GAP) + SERVER_PADDING + NODE_GAP;

    const serverNodeId = `server:${server.id}`;
    const savedPos = savedPositions?.[serverNodeId];
    // Prefer saved size from a prior resize; otherwise fall back to the
    // computed bounding box. Clamp NodeResizer to the computed minimums so
    // children with extent:'parent' don't get clipped.
    const serverWidth = savedPos?.width ?? computedWidth;
    const serverHeight = savedPos?.height ?? computedHeight;

    // Position the server group: inside its cluster's local coordinate space
    // when clustered, otherwise on the canvas. For clustered servers we lay
    // them out with a simple per-cluster cursor unless saved-relative positions
    // are present.
    let position: { x: number; y: number };
    if (inCluster) {
      const cursor = clusterCursor.get(inCluster)!;
      // savedPos may be stale from when the server was top-level (absolute
      // coords) before being re-parented. If it looks unreasonable for the
      // cluster's local coordinate space, fall back to the cursor layout so
      // the child doesn't get clamped far outside the cluster bounds.
      const savedLooksRelative =
        savedPos &&
        savedPos.x >= 0 &&
        savedPos.x <= cursor.width - 50 &&
        savedPos.y >= 0;
      position = savedLooksRelative
        ? { x: savedPos!.x, y: savedPos!.y }
        : { x: cursor.x, y: cursor.y };
      // Only advance the cursor when we actually placed the server via the
      // cursor — otherwise the next sibling gets bumped by a phantom slot.
      if (!savedLooksRelative) {
        cursor.x += computedWidth + SERVER_GAP;
        cursor.maxRowHeight = Math.max(cursor.maxRowHeight, computedHeight);
        // Wrap to a new row if the next server (assume ~200px wide) wouldn't
        // fit inside the cluster's effective width. Without this, children
        // past the right edge stack on top of each other once extent:'parent'
        // clamps them.
        if (cursor.x + 200 > cursor.width - 12) {
          cursor.x = 12;
          cursor.y += cursor.maxRowHeight + SERVER_GAP;
          cursor.maxRowHeight = 0;
        }
      }
    } else {
      position = savedPos ? { x: savedPos.x, y: savedPos.y } : { x: serverX, y: 0 };
    }

    nodes.push({
      id: serverNodeId,
      type: 'serverGroup',
      position,
      ...(inCluster ? { parentId: `cluster:${inCluster}`, extent: 'parent' as const } : {}),
      data: {
        label: server.name,
        serverId: server.id,
        status: server.status,
        serviceCount: server.services.length,
        collapsed: isCollapsed,
        onToggleCollapse,
        // Pass the computed bounding-box as the NodeResizer floor so the user
        // can't shrink below the children's footprint.
        minWidth: computedWidth,
        minHeight: computedHeight,
      },
      style: { width: serverWidth, height: serverHeight },
    });

    if (!isCollapsed) {
      let childIndex = 0;
      for (const service of server.services) {
        const col = childIndex % columns;
        const row = Math.floor(childIndex / columns);
        const ports = parseExposedPorts(service.exposedPorts);
        const primaryPort = ports.length > 0 ? ports[0].container : null;

        const nodeId = `service:${service.id}`;
        // Child positions are relative to parent; only use saved if no parent change
        nodes.push({
          id: nodeId,
          type: 'serviceNode',
          position: {
            x: SERVER_PADDING + col * (NODE_WIDTH + NODE_GAP),
            y: SERVER_HEADER_HEIGHT + row * (NODE_HEIGHT + NODE_GAP),
          },
          parentId: serverNodeId,
          extent: 'parent' as const,
          data: {
            label: service.name,
            serviceId: service.id,
            // Per-server runtime fields now live on ServiceDeployment; the back-compat
            // surface exposes them as optional on the flattened service row, so we
            // fall back to 'unknown' for templates that don't yet have a deployment.
            status: service.status ?? 'unknown',
            healthStatus: service.healthStatus ?? 'unknown',
            containerStatus: service.containerStatus ?? 'unknown',
            image: service.containerImage
              ? `${service.containerImage.imageName}:${service.imageTag}`
              : service.imageTag,
            ports,
            primaryPort,
          } satisfies ServiceNodeData,
        });
        childIndex++;
      }

      for (const db of serverDatabases) {
        const col = childIndex % columns;
        const row = Math.floor(childIndex / columns);

        nodes.push({
          id: `database:${db.id}`,
          type: 'databaseNode',
          position: {
            x: SERVER_PADDING + col * (NODE_WIDTH + NODE_GAP),
            y: SERVER_HEADER_HEIGHT + row * (NODE_HEIGHT + NODE_GAP),
          },
          parentId: serverNodeId,
          extent: 'parent' as const,
          data: {
            label: db.name,
            databaseId: db.id,
            dbType: db.databaseType?.displayName || db.type,
            port: db.port,
            status: 'unknown',
          } satisfies DatabaseNodeData,
        });
        childIndex++;
      }
    }

    // Only unclustered servers advance the canvas-level cursor; clustered
    // servers consume cluster-local space.
    if (!inCluster) {
      serverX += serverWidth + SERVER_GAP;
    }
  }

  const standaloneDatabases = databases.filter((db) => !placedDatabaseIds.has(db.id));
  standaloneDatabases.forEach((db, i) => {
    const nodeId = `database:${db.id}`;
    const savedPos = savedPositions?.[nodeId];
    nodes.push({
      id: nodeId,
      type: 'databaseNode',
      position: savedPos
        ? { x: savedPos.x, y: savedPos.y }
        : {
            x: serverX + DATABASE_STANDALONE_X_OFFSET,
            y: i * (NODE_HEIGHT + NODE_GAP * 2),
          },
      data: {
        label: db.name,
        databaseId: db.id,
        dbType: db.databaseType?.displayName || db.type,
        port: db.port,
        status: 'unknown',
      } satisfies DatabaseNodeData,
    });
  });

  // External entities — fall back to their stored x/y, but prefer saved
  // canvas-layout positions if present.
  externalEntities.forEach((ext, i) => {
    const nodeId = `external:${ext.id}`;
    const savedPos = savedPositions?.[nodeId];
    const data: ExternalEntityNodeData = {
      label: ext.label,
      externalEntityId: ext.id,
      kind: ext.kind,
      iconKey: ext.iconKey,
      onDelete: onDeleteExternalEntity,
    };
    nodes.push({
      id: nodeId,
      type: 'externalEntity',
      position: savedPos
        ? { x: savedPos.x, y: savedPos.y }
        : { x: ext.x, y: ext.y || i * 70 },
      data: data as unknown as Record<string, unknown>,
      style: {
        width: savedPos?.width ?? ext.width ?? 160,
        height: savedPos?.height ?? ext.height ?? 48,
      },
    });
  });

  return { nodes, serviceToServer, databaseToServer, serverToCluster };
}

function topologyEdgesToReactFlow(
  topologyEdges: TopologyEdge[],
  onDelete: ((connectionId: string) => void) | null,
): Edge[] {
  return topologyEdges.map((te) => {
    // Extract manual connection ID from edge ID (format: "manual:<connectionId>")
    const manualId = te.type === 'manual' && te.id.startsWith('manual:') ? te.id.replace('manual:', '') : undefined;
    // Suppress inline delete for aggregated edges — the user can't tell which
    // underlying connection the X would destroy.
    const canDelete = manualId && onDelete && !te.aggregated;

    return {
      id: te.id,
      source: te.source,
      sourceHandle: te.sourceHandle ?? undefined,
      target: te.target,
      targetHandle: te.targetHandle ?? undefined,
      type: 'topology',
      markerEnd: te.directed
        ? { type: MarkerType.ArrowClosed, color: te.type === 'auto' ? '#60a5fa' : '#4ade80', width: 16, height: 16 }
        : undefined,
      data: {
        edgeType: te.type,
        label: te.label,
        port: te.port,
        protocol: te.protocol,
        manualId: canDelete ? manualId : undefined,
        onDelete: canDelete ? onDelete : undefined,
        aggregated: te.aggregated,
      },
    };
  });
}

const reactFlowDarkStyles = `
.react-flow__controls-button {
  background: #1e293b !important;
  border-color: #334155 !important;
  fill: #94a3b8 !important;
}
.react-flow__controls-button:hover {
  background: #334155 !important;
  fill: #f1f5f9 !important;
}
.react-flow__controls-button svg {
  fill: inherit !important;
}
.topology-handle {
  width: 10px !important;
  height: 10px !important;
  background: #64748b !important;
  border: 2px solid #0f172a !important;
  transition: background-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
}
.topology-handle-db {
  background: #a78bfa !important;
}
.react-flow__node-serviceNode:hover .topology-handle,
.react-flow__node-databaseNode:hover .topology-handle,
.react-flow__node-serverGroup:hover > div > .topology-handle,
.react-flow__handle-connecting,
.react-flow__handle-valid {
  background: #3b82f6 !important;
  transform: scale(1.4);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
}
.react-flow__handle-valid {
  background: #22c55e !important;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.3);
}
.react-flow__edge.selected .react-flow__edge-path {
  filter: drop-shadow(0 0 4px rgba(74, 222, 128, 0.5));
}
.react-flow__connectionline path {
  stroke: #60a5fa !important;
  stroke-width: 2 !important;
  stroke-dasharray: 5 5;
}
`;

function DiagramInner({ servers, databases, environmentId, userRole }: TopologyDiagramProps) {
  const [mode, setMode] = useState<DiagramMode>('compact');
  const [collapsedServers, setCollapsedServers] = useState<Set<string>>(new Set());
  const [manualConnections, setManualConnections] = useState<ServiceConnection[]>([]);
  const [savedPositions, setSavedPositions] = useState<DiagramLayoutPositions | null>(null);
  const [showConnectionsList, setShowConnectionsList] = useState(false);
  const [showAddConnectionModal, setShowAddConnectionModal] = useState(false);
  // Drives the create-cluster / create-external-entity Dialog forms (these
  // replaced the old browser-prompt flows).
  const [showCreateClusterDialog, setShowCreateClusterDialog] = useState(false);
  const [showCreateExternalDialog, setShowCreateExternalDialog] = useState(false);
  const [externalEntities, setExternalEntities] = useState<ExternalEntity[]>([]);
  const [serverClusters, setServerClusters] = useState<ServerCluster[]>([]);
  const reactFlowInstance = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectStartNodeRef = useRef<string | null>(null);
  // Incremented on every environment change and on every local mutation so
  // late-arriving fetch responses for stale environments / pre-mutation snapshots
  // can be discarded.
  const fetchGenRef = useRef(0);
  const isDraggingRef = useRef(false);
  const toast = useToast();

  const canInteract = userRole === 'admin' || userRole === 'operator';

  const handleDeleteConnection = useCallback(async (connectionId: string) => {
    let removed: ServiceConnection | undefined;
    setManualConnections((prev) => {
      removed = prev.find((c) => c.id === connectionId);
      return prev.filter((c) => c.id !== connectionId);
    });
    fetchGenRef.current++;
    try {
      await deleteConnection(connectionId);
    } catch (err) {
      // Roll back the optimistic removal and surface the error.
      if (removed) {
        setManualConnections((prev) => (prev.some((c) => c.id === connectionId) ? prev : [...prev, removed!]));
      }
      toast.error(`Failed to delete connection: ${getErrorMessage(err, 'Unknown error')}`);
    }
  }, [toast]);

  // Fetch manual connections
  useEffect(() => {
    if (!environmentId) return;
    // Reset immediately on environment change so we don't briefly render
    // env-A connections in env-B.
    setManualConnections([]);
    fetchGenRef.current++;
    const myGen = fetchGenRef.current;
    listConnections(environmentId)
      .then((res) => {
        if (myGen !== fetchGenRef.current) return;
        setManualConnections(res.connections || []);
      })
      .catch(() => {
        if (myGen !== fetchGenRef.current) return;
        setManualConnections([]);
      });
  }, [environmentId]);

  // Fetch saved layout
  useEffect(() => {
    if (!environmentId) return;
    setSavedPositions(null);
    let cancelled = false;
    getDiagramLayout(environmentId)
      .then((res) => {
        if (cancelled) return;
        if (res.layout?.positions) {
          setSavedPositions(res.layout.positions);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [environmentId]);

  // Fetch external entities & server clusters in parallel — reset eagerly on
  // env change for the same reason as manualConnections.
  useEffect(() => {
    if (!environmentId) return;
    setExternalEntities([]);
    setServerClusters([]);
    let cancelled = false;
    Promise.all([listExternalEntities(environmentId), listServerClusters(environmentId)])
      .then(([extRes, clRes]) => {
        if (cancelled) return;
        setExternalEntities(extRes.externalEntities || []);
        setServerClusters(clRes.serverClusters || []);
      })
      .catch(() => {
        if (cancelled) return;
        setExternalEntities([]);
        setServerClusters([]);
      });
    return () => { cancelled = true; };
  }, [environmentId]);

  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set());

  // Reflect the persisted `collapsed` flag from the server into local state.
  // Rebuild the Set fully on each fetch — the server is the source of truth
  // because `handleToggleClusterCollapse` already persists optimistic toggles
  // via `updateServerCluster({ collapsed })`. Union-merging would silently
  // re-collapse a cluster the user just expanded if a concurrent refetch
  // returns a stale `collapsed: true`.
  useEffect(() => {
    setCollapsedClusters(
      new Set(serverClusters.filter((c) => c.collapsed).map((c) => c.id))
    );
  }, [serverClusters]);

  const handleToggleCollapse = useCallback((serverId: string) => {
    setCollapsedServers((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
      }
      return next;
    });
  }, []);

  const handleCollapseAll = useCallback(() => {
    setCollapsedServers(new Set(servers.map((s) => s.id)));
  }, [servers]);

  const handleExpandAll = useCallback(() => {
    setCollapsedServers(new Set());
  }, []);

  const handleFitView = useCallback(() => {
    reactFlowInstance.fitView({ padding: 0.2, duration: 300 });
  }, [reactFlowInstance]);

  // Track active drag so the nodes-sync effect doesn't clobber in-progress positions.
  const handleNodeDragStart: OnNodeDrag = useCallback(() => {
    isDraggingRef.current = true;
  }, []);

  // Snapshot the current canvas-level positions (top-level nodes only) and
  // persist them, including any resized width/height. Used by both
  // drag-stop and resize-end so both interactions share the same store shape.
  const scheduleLayoutSave = useCallback(() => {
    if (!canInteract || !environmentId) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Capture environmentId in the closure so a late timer fires against the
    // correct env even if the user has since navigated away.
    const targetEnv = environmentId;
    saveTimeoutRef.current = setTimeout(() => {
      const currentNodes = reactFlowInstance.getNodes();
      const positions: DiagramLayoutPositions = {};
      for (const n of currentNodes) {
        // Persist the node IDs that `buildNodes` reads back from
        // savedPositions: clusters, servers (both top-level and clustered),
        // standalone databases, and external entities. Child service/database
        // nodes inside a server are positioned by computed grid and aren't
        // user-draggable, so we skip them. The previous `!n.parentId` guard
        // incorrectly dropped clustered servers — their parentId is the
        // cluster, but their drag/resize state still needs to round-trip.
        const isSaveable =
          n.id.startsWith('cluster:') ||
          n.id.startsWith('server:') ||
          n.id.startsWith('database:') ||
          n.id.startsWith('external:');
        if (!isSaveable) continue;
        // For child databases under a server (parentId starts with `server:`)
        // skip: they're laid out by the grid alongside services, not by
        // savedPositions. Only standalone databases (no parent) round-trip.
        if (n.id.startsWith('database:') && n.parentId) continue;
        // Pull width/height off either the inline style or measured size,
        // whichever is available — NodeResizer writes to both.
        const styleWidth = typeof n.style?.width === 'number' ? (n.style.width as number) : undefined;
        const styleHeight = typeof n.style?.height === 'number' ? (n.style.height as number) : undefined;
        const measuredWidth = n.measured?.width ?? n.width ?? undefined;
        const measuredHeight = n.measured?.height ?? n.height ?? undefined;
        positions[n.id] = {
          x: n.position.x,
          y: n.position.y,
          ...(styleWidth !== undefined || measuredWidth !== undefined ? { width: styleWidth ?? measuredWidth! } : {}),
          ...(styleHeight !== undefined || measuredHeight !== undefined ? { height: styleHeight ?? measuredHeight! } : {}),
        };
      }
      saveDiagramLayout(targetEnv, positions).catch(() => {});
    }, 1000);
  }, [canInteract, environmentId, reactFlowInstance]);

  // Layout persistence: debounced save on drag end
  const handleNodeDragStop: OnNodeDrag = useCallback((_event, _node) => {
    isDraggingRef.current = false;
    scheduleLayoutSave();
  }, [scheduleLayoutSave]);

  // Cancel any pending layout save when the environment changes or on unmount —
  // otherwise the timer fires against the now-current env and overwrites its
  // saved layout with the previous env's coordinates.
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, [environmentId]);

  // Track which node the user started dragging from
  const handleConnectStart = useCallback((_event: MouseEvent | TouchEvent, params: { nodeId: string | null }) => {
    connectStartNodeRef.current = params.nodeId;
  }, []);

  // Always clear the start ref when the drag ends — successful drops clear it
  // inside handleConnect, but cancelled drags (drop on empty canvas) need this.
  const handleConnectEnd: OnConnectEnd = useCallback(() => {
    connectStartNodeRef.current = null;
  }, []);

  // Handle on-diagram edge creation
  const handleConnect: OnConnect = useCallback(async (connection: Connection) => {
    if (!canInteract || !connection.source || !connection.target) {
      connectStartNodeRef.current = null;
      return;
    }

    // Parse node IDs (format: "service:<id>" | "database:<id>" | "external:<id>").
    // We narrow to the persisted endpoint types — server/cluster IDs cannot be
    // either source or target of a stored connection.
    const parseNodeId = (nodeId: string): { type: ConnectionEndpointType | 'server' | 'cluster'; id: string } => {
      const [type, ...rest] = nodeId.split(':');
      return { type: type as ConnectionEndpointType | 'server' | 'cluster', id: rest.join(':') };
    };

    // React Flow normalizes connections so source always has a "source" handle,
    // regardless of drag direction. Use the tracked start node to preserve
    // the user's intended direction AND the user-chosen handle on each side.
    let sourceNodeId = connection.source;
    let targetNodeId = connection.target;
    let sourceHandle = connection.sourceHandle ?? null;
    let targetHandle = connection.targetHandle ?? null;
    if (connectStartNodeRef.current && connectStartNodeRef.current !== connection.source) {
      sourceNodeId = connection.target;
      targetNodeId = connection.source;
      sourceHandle = connection.targetHandle ?? null;
      targetHandle = connection.sourceHandle ?? null;
    }
    connectStartNodeRef.current = null;

    const source = parseNodeId(sourceNodeId);
    const target = parseNodeId(targetNodeId);

    // Drop connections involving server/cluster aggregate nodes — they aren't
    // a persistent endpoint type.
    const isValidEndpoint = (t: string): t is ConnectionEndpointType =>
      t === 'service' || t === 'database' || t === 'external';
    if (!isValidEndpoint(source.type) || !isValidEndpoint(target.type)) return;

    try {
      const conn = await createConnection({
        environmentId,
        sourceType: source.type,
        sourceId: source.id,
        sourceHandle,
        targetType: target.type,
        targetId: target.id,
        targetHandle,
        direction: 'forward',
      });
      fetchGenRef.current++;
      setManualConnections((prev) => (prev.some((c) => c.id === conn.id) ? prev : [...prev, conn]));
    } catch (err) {
      toast.error(`Failed to create connection: ${getErrorMessage(err, 'Unknown error')}`);
    }
  }, [canInteract, environmentId, toast]);

  // ==================== Cluster handlers ====================

  const handleToggleClusterCollapse = useCallback((clusterId: string) => {
    setCollapsedClusters((prev) => {
      const next = new Set(prev);
      const wasCollapsed = next.has(clusterId);
      if (wasCollapsed) next.delete(clusterId);
      else next.add(clusterId);
      // Best-effort persist to the server — local state is authoritative for
      // immediate UI feedback.
      if (canInteract) {
        updateServerCluster(clusterId, { collapsed: !wasCollapsed }).catch(() => {});
      }
      return next;
    });
  }, [canInteract]);

  const handleDeleteCluster = useCallback(async (clusterId: string) => {
    if (!canInteract) return;
    const removed = serverClusters.find((c) => c.id === clusterId);
    setServerClusters((prev) => prev.filter((c) => c.id !== clusterId));
    try {
      await deleteServerCluster(clusterId);
    } catch (err) {
      if (removed) setServerClusters((prev) => (prev.some((c) => c.id === clusterId) ? prev : [...prev, removed]));
      toast.error(`Failed to delete cluster: ${getErrorMessage(err, 'Unknown error')}`);
    }
  }, [canInteract, serverClusters, toast]);

  // Opens the create-cluster dialog (cancel = no-op). The actual create runs
  // in submitCreateCluster once the user confirms a name.
  const handleCreateCluster = useCallback(() => {
    if (!canInteract || !environmentId) return;
    setShowCreateClusterDialog(true);
  }, [canInteract, environmentId]);

  const submitCreateCluster = useCallback(async (name: string) => {
    if (!canInteract || !environmentId) return;
    try {
      // Place the new cluster at the current viewport center so it lands on
      // screen rather than at (0,0).
      const { x: vx, y: vy, zoom } = reactFlowInstance.getViewport();
      const center = {
        x: ((-vx) / Math.max(0.1, zoom)) + 200,
        y: ((-vy) / Math.max(0.1, zoom)) + 80,
      };
      const res = await createServerCluster(environmentId, {
        name: name.trim(),
        x: center.x,
        y: center.y,
        width: 640,
        height: 280,
      });
      setServerClusters((prev) => [...prev, res.serverCluster]);
      setShowCreateClusterDialog(false);
    } catch (err) {
      toast.error(`Failed to create cluster: ${getErrorMessage(err, 'Unknown error')}`);
    }
  }, [canInteract, environmentId, reactFlowInstance, toast]);

  // ==================== External entity handlers ====================

  const handleDeleteExternalEntity = useCallback(async (id: string) => {
    if (!canInteract) return;
    const removed = externalEntities.find((e) => e.id === id);
    setExternalEntities((prev) => prev.filter((e) => e.id !== id));
    try {
      await deleteExternalEntity(id);
    } catch (err) {
      if (removed) setExternalEntities((prev) => (prev.some((e) => e.id === id) ? prev : [...prev, removed]));
      toast.error(`Failed to delete external entity: ${getErrorMessage(err, 'Unknown error')}`);
    }
  }, [canInteract, externalEntities, toast]);

  // Opens the create-external-entity dialog (cancel = no-op). The create runs
  // in submitCreateExternalEntity once the user confirms label + kind.
  const handleCreateExternalEntity = useCallback(() => {
    if (!canInteract || !environmentId) return;
    setShowCreateExternalDialog(true);
  }, [canInteract, environmentId]);

  const submitCreateExternalEntity = useCallback(async (label: string, kind: string) => {
    if (!canInteract || !environmentId) return;
    try {
      const { x: vx, y: vy, zoom } = reactFlowInstance.getViewport();
      const center = {
        x: ((-vx) / Math.max(0.1, zoom)) + 80,
        y: ((-vy) / Math.max(0.1, zoom)) + 200,
      };
      const res = await createExternalEntity(environmentId, {
        label: label.trim(),
        kind: (kind || 'web').trim(),
        x: center.x,
        y: center.y,
      });
      setExternalEntities((prev) => [...prev, res.externalEntity]);
      setShowCreateExternalDialog(false);
    } catch (err) {
      toast.error(`Failed to create external entity: ${getErrorMessage(err, 'Unknown error')}`);
    }
  }, [canInteract, environmentId, reactFlowInstance, toast]);

  // ==================== Resize-end persistence ====================

  // React Flow fires a `dimensions` change with `resizing: true` while the
  // user is dragging a NodeResizer handle, then a final dimensions change
  // when they release. We piggyback the same debounced save used for drags
  // and also persist updated positions for external entities back to their
  // own row (so they survive a layout reset).
  const handleNodeResizeEnd = useCallback((_event: unknown, node: Node) => {
    scheduleLayoutSave();
    // Best-effort: when an external entity is resized, persist its position
    // to its own row too. We use the inline style if present, else measured.
    if (node.id.startsWith('external:')) {
      const id = node.id.slice('external:'.length);
      const width = typeof node.style?.width === 'number' ? (node.style.width as number) : node.measured?.width;
      const height = typeof node.style?.height === 'number' ? (node.style.height as number) : node.measured?.height;
      updateExternalEntity(id, {
        x: node.position.x,
        y: node.position.y,
        width: width ?? null,
        height: height ?? null,
      }).catch(() => {});
    } else if (node.id.startsWith('cluster:')) {
      const id = node.id.slice('cluster:'.length);
      const width = typeof node.style?.width === 'number' ? (node.style.width as number) : node.measured?.width;
      const height = typeof node.style?.height === 'number' ? (node.style.height as number) : node.measured?.height;
      updateServerCluster(id, {
        x: node.position.x,
        y: node.position.y,
        width: width ?? null,
        height: height ?? null,
      }).catch(() => {});
    }
  }, [scheduleLayoutSave]);

  // ESC to exit fullscreen — but only when no modal is open, otherwise the
  // same keypress would close the modal AND drop out of fullscreen.
  useEffect(() => {
    if (mode !== 'fullscreen') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showAddConnectionModal) return;
      setMode('expanded');
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mode, showAddConnectionModal]);

  // Export — the DropdownMenu (see ExportMenu) owns its own open state, so no
  // manual menu-visibility state or outside-click listener is needed.
  const handleExportMermaid = useCallback(async () => {
    try {
      const res = await exportDiagramMermaid(environmentId);
      downloadFile('topology.md', res.mermaid, 'text/markdown');
    } catch (err) {
      // B14: surface export failures instead of swallowing them.
      toast.error(`Failed to export diagram: ${getErrorMessage(err, 'Unknown error')}`);
    }
  }, [environmentId, toast]);

  const handleExportPng = useCallback(async () => {
    const viewport = document.querySelector('.react-flow__viewport') as HTMLElement | null;
    if (!viewport) return;
    try {
      const dataUrl = await toPng(viewport, {
        backgroundColor: '#0a0e14', // Deep Slate shell
        pixelRatio: 2,
        skipFonts: true,
      });
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'topology.png';
      a.click();
    } catch (err) {
      // B14: surface export failures instead of swallowing them.
      toast.error(`Failed to export PNG: ${getErrorMessage(err, 'Unknown error')}`);
    }
  }, [toast]);

  // Build name lookup for connection list display
  const nodeNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const server of servers) {
      for (const service of server.services) {
        map.set(`service:${service.id}`, service.name);
      }
    }
    for (const db of databases) {
      map.set(`database:${db.id}`, db.name);
    }
    for (const ext of externalEntities) {
      map.set(`external:${ext.id}`, ext.label);
    }
    return map;
  }, [servers, databases, externalEntities]);

  const { nodes, serviceToServer, databaseToServer, serverToCluster } = useMemo(
    () => buildNodes({
      servers,
      databases,
      externalEntities,
      serverClusters,
      collapsedServers,
      collapsedClusters,
      savedPositions,
      onToggleCollapse: handleToggleCollapse,
      onToggleClusterCollapse: canInteract ? handleToggleClusterCollapse : undefined,
      onDeleteCluster: canInteract ? handleDeleteCluster : undefined,
      onDeleteExternalEntity: canInteract ? handleDeleteExternalEntity : undefined,
    }),
    [
      servers,
      databases,
      externalEntities,
      serverClusters,
      collapsedServers,
      collapsedClusters,
      savedPositions,
      handleToggleCollapse,
      canInteract,
      handleToggleClusterCollapse,
      handleDeleteCluster,
      handleDeleteExternalEntity,
    ]
  );

  const edges = useMemo(() => {
    const inferred = inferConnections(servers, databases);
    const merged = mergeConnections(inferred, manualConnections);
    const aggregated = aggregateCollapsedEdges(
      merged,
      collapsedServers,
      serviceToServer,
      databaseToServer,
      collapsedClusters,
      serverToCluster,
    );
    return topologyEdgesToReactFlow(aggregated, canInteract ? handleDeleteConnection : null);
  }, [
    servers,
    databases,
    manualConnections,
    collapsedServers,
    serviceToServer,
    databaseToServer,
    collapsedClusters,
    serverToCluster,
    canInteract,
    handleDeleteConnection,
  ]);

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(nodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(edges);

  // Sync nodes — but skip while the user is mid-drag, otherwise an unrelated
  // re-render (collapse toggle, savedPositions arrival, etc.) snaps the
  // dragged node back to its memo position.
  useEffect(() => {
    if (isDraggingRef.current) return;
    setFlowNodes(nodes);
  }, [nodes, setFlowNodes]);

  // Sync edges, preserving ReactFlow's per-edge `selected` flag so the user's
  // current edge selection survives unrelated state changes (adding/deleting
  // other connections, collapsing servers, etc.).
  useEffect(() => {
    setFlowEdges((prev) => {
      if (prev.length === 0) return edges;
      const selectedIds = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      if (selectedIds.size === 0) return edges;
      return edges.map((e) => (selectedIds.has(e.id) ? { ...e, selected: true } : e));
    });
  }, [edges, setFlowEdges]);

  // Wrap onNodesChange so we can fire a "resize end" callback for resizable
  // nodes (server groups, external entities, clusters). ReactFlow fires
  // `dimensions` changes with `resizing: true` while the user drags a
  // NodeResizer handle, and a final change when they release. We track the
  // last-seen resizing state per node and fire on the falling edge.
  const resizingNodeIdsRef = useRef<Set<string>>(new Set());
  const handleNodesChange = useCallback((changes: import('@xyflow/react').NodeChange[]) => {
    if (canInteract) {
      for (const change of changes) {
        if (change.type !== 'dimensions') continue;
        const id = change.id;
        const isResizing = Boolean((change as { resizing?: boolean }).resizing);
        const was = resizingNodeIdsRef.current.has(id);
        if (isResizing) {
          resizingNodeIdsRef.current.add(id);
        } else if (was) {
          resizingNodeIdsRef.current.delete(id);
          // Defer to next tick so the new dimensions have been applied to the node.
          const node = reactFlowInstance.getNode(id);
          if (node) {
            setTimeout(() => handleNodeResizeEnd(null, node), 0);
          }
        }
      }
    }
    onNodesChange(changes);
  }, [canInteract, onNodesChange, handleNodeResizeEnd, reactFlowInstance]);

  // Wrap onEdgesChange: ReactFlow fires `remove` changes when the user presses
  // Backspace/Delete on a selected edge. Without this wrap the change is
  // applied only to flowEdges (not manualConnections), so the next edges-memo
  // rebuild restores the edge — visible flicker. Route manual-edge removes
  // through the API and drop everything else so auto-inferred edges aren't
  // even momentarily removable via keyboard.
  const handleEdgesChange: OnEdgesChange = useCallback((changes) => {
    const passthrough: EdgeChange[] = [];
    for (const change of changes) {
      if (change.type === 'remove') {
        const removed = flowEdges.find((e) => e.id === change.id);
        const data = removed?.data as TopologyEdgeData | undefined;
        if (canInteract && data?.manualId && !data.aggregated) {
          handleDeleteConnection(data.manualId);
        }
        continue;
      }
      passthrough.push(change);
    }
    if (passthrough.length > 0) {
      onEdgesChange(passthrough);
    }
  }, [flowEdges, canInteract, handleDeleteConnection, onEdgesChange]);

  const heightClass = mode === 'compact' ? 'h-[350px]' : mode === 'expanded' ? 'h-[700px]' : '';
  const totalServices = servers.reduce((acc, s) => acc + s.services.length, 0);
  const isEmpty =
    servers.length === 0 &&
    databases.length === 0 &&
    externalEntities.length === 0 &&
    serverClusters.length === 0;

  if (isEmpty) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-foreground">Environment Diagram</h2>
        </div>
        <EmptyState
          icon={Network}
          message="No services discovered yet"
          description="Add servers and discover containers to see the topology diagram"
        />
      </div>
    );
  }

  const flowProps = {
    nodes: flowNodes,
    edges: flowEdges,
    onNodesChange: canInteract ? handleNodesChange : undefined,
    onEdgesChange: handleEdgesChange,
    onNodeDragStart: canInteract ? handleNodeDragStart : undefined,
    onNodeDragStop: canInteract ? handleNodeDragStop : undefined,
    nodeTypes,
    edgeTypes,
    fitView: true,
    fitViewOptions: { padding: 0.2 },
    onConnect: canInteract ? handleConnect : undefined,
    onConnectStart: canInteract ? handleConnectStart : undefined,
    onConnectEnd: canInteract ? handleConnectEnd : undefined,
    connectionMode: ConnectionMode.Loose,
    connectionRadius: 28,
    nodesDraggable: canInteract,
    nodesConnectable: canInteract,
    edgesFocusable: canInteract,
    edgesSelectable: canInteract,
    elementsSelectable: canInteract,
    proOptions: { hideAttribution: true },
  };

  const addConnectionModal = canInteract ? (
    <>
      <AddConnectionModal
        isOpen={showAddConnectionModal}
        onClose={() => setShowAddConnectionModal(false)}
        environmentId={environmentId}
        servers={servers}
        databases={databases}
        externalEntities={externalEntities}
        onConnectionCreated={(conn) => setManualConnections((prev) => [...prev, conn])}
      />
      <CreateClusterDialog
        open={showCreateClusterDialog}
        onOpenChange={setShowCreateClusterDialog}
        onSubmit={submitCreateCluster}
      />
      <CreateExternalEntityDialog
        open={showCreateExternalDialog}
        onOpenChange={setShowCreateExternalDialog}
        onSubmit={submitCreateExternalEntity}
      />
    </>
  ) : null;

  if (mode === 'fullscreen') {
    return (
      <>
        <style>{reactFlowDarkStyles}</style>
        <div className="fixed inset-0 bg-background z-50 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-foreground">Environment Diagram</h2>
              <span className="text-xs text-muted-foreground">
                {servers.length} server{servers.length !== 1 ? 's' : ''} &middot; {totalServices} service{totalServices !== 1 ? 's' : ''} &middot; {databases.length} database{databases.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <ToolbarButtons
                onCollapseAll={handleCollapseAll}
                onExpandAll={handleExpandAll}
                onFitView={handleFitView}
              />
              {canInteract && (
                <>
                  <AddExternalEntityButton onClick={handleCreateExternalEntity} />
                  <NewClusterButton onClick={handleCreateCluster} />
                  <AddConnectionButton onClick={() => setShowAddConnectionModal(true)} />
                  <ConnectionsListButton
                    connections={manualConnections}
                    nodeNameMap={nodeNameMap}
                    onDelete={handleDeleteConnection}
                    show={showConnectionsList}
                    onOpenChange={setShowConnectionsList}
                  />
                </>
              )}
              <ExportMenu onExportMermaid={handleExportMermaid} onExportPng={handleExportPng} />
              <Button variant="secondary" size="sm" onClick={() => setMode('expanded')} title="Exit fullscreen (Esc)">
                <Minimize2 className="w-4 h-4" aria-hidden="true" />
                Exit Fullscreen
              </Button>
            </div>
          </div>
          <div className="flex-1">
            <ReactFlow {...flowProps}>
              <Background color="#334155" gap={20} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={(n) => {
                  if (n.type === 'serverGroup') return '#334155';
                  if (n.type === 'databaseNode') return '#7c3aed';
                  return '#3b82f6';
                }}
                className="!bg-card !border-border"
              />
            </ReactFlow>
          </div>
          <div className="flex items-center gap-4 px-4 py-2 border-t border-border text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-info inline-block rounded" />
              Auto-inferred
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-success inline-block rounded" />
              Manual
            </div>
            {canInteract && (
              <div className="text-muted-foreground ml-auto">
                Drag from a node handle (the dots on each side) onto another node to connect.
              </div>
            )}
          </div>
        </div>
        {addConnectionModal}
      </>
    );
  }

  return (
    <>
      <style>{reactFlowDarkStyles}</style>
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-foreground">Environment Diagram</h2>
            <span className="text-xs text-muted-foreground">
              {servers.length} server{servers.length !== 1 ? 's' : ''} &middot; {totalServices} service{totalServices !== 1 ? 's' : ''} &middot; {databases.length} database{databases.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ToolbarButtons
              onCollapseAll={handleCollapseAll}
              onExpandAll={handleExpandAll}
              onFitView={handleFitView}
            />
            {canInteract && (
              <>
                <AddConnectionButton onClick={() => setShowAddConnectionModal(true)} />
                <ConnectionsListButton
                  connections={manualConnections}
                  nodeNameMap={nodeNameMap}
                  onDelete={handleDeleteConnection}
                  show={showConnectionsList}
                  onOpenChange={setShowConnectionsList}
                />
              </>
            )}
            <ExportMenu onExportMermaid={handleExportMermaid} onExportPng={handleExportPng} />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMode(mode === 'compact' ? 'expanded' : 'compact')}
              title={mode === 'compact' ? 'Expand' : 'Compact'}
              aria-label={mode === 'compact' ? 'Expand' : 'Compact'}
            >
              {mode === 'compact' ? (
                <Maximize2 className="w-4 h-4" aria-hidden="true" />
              ) : (
                <Minimize2 className="w-4 h-4" aria-hidden="true" />
              )}
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setMode('fullscreen')} title="Fullscreen" aria-label="Fullscreen">
              <Maximize2 className="w-4 h-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div ref={containerRef} className={`${heightClass} rounded-lg overflow-hidden border border-border`}>
          <ReactFlow {...flowProps}>
            <Background color="#334155" gap={20} size={1} />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        </div>
        {edges.length > 0 && (
          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-info inline-block rounded" />
              Auto-inferred
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-success inline-block rounded" />
              Manual
            </div>
            {canInteract && (
              <div className="text-muted-foreground ml-auto hidden md:block">
                Hover a node, drag from a side dot to connect.
              </div>
            )}
          </div>
        )}
      </div>
      {addConnectionModal}
    </>
  );
}

// ==================== Create dialogs (shadcn Dialog forms) ====================

const clusterSchema = z.object({
  name: z.string().trim().min(1, 'Cluster name is required'),
});
type ClusterValues = z.infer<typeof clusterSchema>;

// Collects a cluster name. Cancel (dialog dismiss) = no-op, preserving the
// original behavior where an empty/cancelled input created nothing.
function CreateClusterDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const form = useForm<ClusterValues>({
    resolver: zodResolver(clusterSchema),
    defaultValues: { name: '' },
  });

  useEffect(() => {
    if (open) form.reset({ name: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSubmit = async (values: ClusterValues) => {
    await onSubmit(values.name);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Cluster</DialogTitle>
          <DialogDescription>
            Group servers into a logical cluster (HA pair, swarm/k8s nodes, a region).
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Cluster name</FormLabel>
                  <FormControl>
                    <Input placeholder='e.g. "Production HA", "EU region"' autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Creating...' : 'Create Cluster'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const externalSchema = z.object({
  label: z.string().trim().min(1, 'Label is required'),
  // Mirrors the old prompt's 'web' default; styling keys off this value.
  kind: z.string().trim().min(1, 'Kind is required'),
});
type ExternalValues = z.infer<typeof externalSchema>;

// Collects label + kind in a single form (previously two chained inputs).
// Cancel = no-op.
function CreateExternalEntityDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (label: string, kind: string) => Promise<void>;
}) {
  const form = useForm<ExternalValues>({
    resolver: zodResolver(externalSchema),
    defaultValues: { label: '', kind: 'web' },
  });

  useEffect(() => {
    if (open) form.reset({ label: '', kind: 'web' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSubmit = async (values: ExternalValues) => {
    await onSubmit(values.label, values.kind);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add External Entity</DialogTitle>
          <DialogDescription>
            Represent inbound external traffic (a CDN, the public web, a client) on the diagram.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Label</FormLabel>
                  <FormControl>
                    <Input placeholder='e.g. "Cloudflare", "Web", "Internet"' autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Kind</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. cloudflare, cdn, web, client" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Adding...' : 'Add Entity'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function AddConnectionButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon" onClick={onClick} title="Add connection" aria-label="Add connection">
      <Plus className="w-4 h-4" aria-hidden="true" />
    </Button>
  );
}

// Export dropdown (Mermaid / PNG). Replaces the hand-rolled menu + outside-click
// listener with a Radix DropdownMenu (Escape + outside-click handled natively).
function ExportMenu({
  onExportMermaid,
  onExportPng,
}: {
  onExportMermaid: () => void;
  onExportPng: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" title="Export" aria-label="Export">
          <Download className="w-4 h-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[140px]">
        <DropdownMenuItem onSelect={onExportMermaid}>Mermaid (.md)</DropdownMenuItem>
        <DropdownMenuItem onSelect={onExportPng}>PNG (.png)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Drops a non-server entity (Cloudflare, "Web", a generic client) on the
// canvas. Used to represent inbound external traffic toward a service.
function AddExternalEntityButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon" onClick={onClick} title="Add external entity" aria-label="Add external entity">
      <Globe className="w-4 h-4" aria-hidden="true" />
    </Button>
  );
}

// Creates a logical cluster (HA pair, swarm/k8s nodes, regional grouping).
// Servers can then be associated with the cluster via their PATCH endpoint
// (or by selection in a separate flow — see docs/guides/topology.md).
function NewClusterButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon" onClick={onClick} title="New cluster" aria-label="New cluster">
      <Layers className="w-4 h-4" aria-hidden="true" />
    </Button>
  );
}

function ConnectionsListButton({
  connections,
  nodeNameMap,
  onDelete,
  show,
  onOpenChange,
}: {
  connections: ServiceConnection[];
  nodeNameMap: Map<string, string>;
  onDelete: (id: string) => void;
  show: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (connections.length === 0) return null;

  const resolveName = (type: string, id: string) =>
    nodeNameMap.get(`${type}:${id}`) || id.slice(0, 8);

  return (
    <DropdownMenu open={show} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" title="Manage connections" aria-label="Manage connections">
          <Link2 className="w-4 h-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[240px] max-h-[300px] overflow-y-auto">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground border-b border-border">
          Manual Connections ({connections.length})
        </div>
        {connections.map((conn) => (
          <div key={conn.id} className="flex items-center justify-between px-2 py-1.5 rounded-sm hover:bg-accent group">
            <div className="flex items-center gap-1 text-sm text-foreground min-w-0">
              <span className="truncate max-w-[80px]" title={resolveName(conn.sourceType, conn.sourceId)}>
                {resolveName(conn.sourceType, conn.sourceId)}
              </span>
              <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" aria-hidden="true" />
              <span className="truncate max-w-[80px]" title={resolveName(conn.targetType, conn.targetId)}>
                {resolveName(conn.targetType, conn.targetId)}
              </span>
            </div>
            <button
              onClick={() => onDelete(conn.id)}
              className="p-0.5 text-muted-foreground hover:text-destructive rounded opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2"
              title="Delete connection"
              aria-label="Delete connection"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToolbarButtons({
  onCollapseAll,
  onExpandAll,
  onFitView,
}: {
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onFitView: () => void;
}) {
  return (
    <>
      <Button variant="ghost" size="icon" onClick={onFitView} title="Fit to view" aria-label="Fit to view">
        <Search className="w-4 h-4" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" onClick={onExpandAll} title="Expand all servers" aria-label="Expand all servers">
        <ChevronDown className="w-4 h-4" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" onClick={onCollapseAll} title="Collapse all servers" aria-label="Collapse all servers">
        <ChevronUp className="w-4 h-4" aria-hidden="true" />
      </Button>
    </>
  );
}

export function TopologyDiagram(props: TopologyDiagramProps) {
  return (
    <ReactFlowProvider>
      <DiagramInner {...props} />
    </ReactFlowProvider>
  );
}
