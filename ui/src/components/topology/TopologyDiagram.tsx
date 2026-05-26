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
import { AddConnectionModal } from './AddConnectionModal';
import type { ServerWithServices, Database, UserRole, ExposedPort, ServiceConnection, DiagramLayoutPositions } from '../../lib/api';
import { listConnections, createConnection, deleteConnection, getDiagramLayout, saveDiagramLayout, exportDiagramMermaid } from '../../lib/api';
import { inferConnections, mergeConnections, aggregateCollapsedEdges, type TopologyEdge } from '../../lib/topology';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import { toPng } from 'html-to-image';
import { safeJsonParse, getErrorMessage } from '../../lib/helpers';

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
            className="absolute flex items-center gap-1 text-[10px] bg-slate-800 border border-slate-600 px-1.5 py-0.5 rounded text-slate-300 pointer-events-auto nopan nodrag"
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
                className="p-0.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded ml-0.5 cursor-pointer"
                title="Delete connection"
                aria-label="Delete connection"
              >
                <svg className="w-3.5 h-3.5 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
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
}

function buildNodes(
  servers: ServerWithServices[],
  databases: Database[],
  collapsedServers: Set<string>,
  onToggleCollapse: (serverId: string) => void,
  savedPositions: DiagramLayoutPositions | null,
): BuildResult {
  const nodes: Node[] = [];
  const serviceToServer = new Map<string, string>();
  const databaseToServer = new Map<string, string>();
  let serverX = 0;

  const placedDatabaseIds = new Set<string>();

  for (const server of servers) {
    const isCollapsed = collapsedServers.has(server.id);
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
    const serverWidth = Math.max(
      200,
      columns * (NODE_WIDTH + NODE_GAP) + SERVER_PADDING * 2 - NODE_GAP
    );
    const serverHeight = isCollapsed
      ? SERVER_HEADER_HEIGHT + 10
      : SERVER_HEADER_HEIGHT + rows * (NODE_HEIGHT + NODE_GAP) + SERVER_PADDING + NODE_GAP;

    const serverNodeId = `server:${server.id}`;
    const savedPos = savedPositions?.[serverNodeId];
    nodes.push({
      id: serverNodeId,
      type: 'serverGroup',
      position: savedPos || { x: serverX, y: 0 },
      data: {
        label: server.name,
        serverId: server.id,
        status: server.status,
        serviceCount: server.services.length,
        collapsed: isCollapsed,
        onToggleCollapse,
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

    serverX += serverWidth + SERVER_GAP;
  }

  const standaloneDatabases = databases.filter((db) => !placedDatabaseIds.has(db.id));
  standaloneDatabases.forEach((db, i) => {
    const nodeId = `database:${db.id}`;
    const savedPos = savedPositions?.[nodeId];
    nodes.push({
      id: nodeId,
      type: 'databaseNode',
      position: savedPos || {
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

  return { nodes, serviceToServer, databaseToServer };
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
  const connectionsListRef = useRef<HTMLDivElement>(null);
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

  // Layout persistence: debounced save on drag end
  const handleNodeDragStop: OnNodeDrag = useCallback((_event, _node) => {
    isDraggingRef.current = false;
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
        // Only save server and standalone (no parent) node positions
        if (!n.parentId) {
          positions[n.id] = { x: n.position.x, y: n.position.y };
        }
      }
      saveDiagramLayout(targetEnv, positions).catch(() => {});
    }, 1000);
  }, [canInteract, environmentId, reactFlowInstance]);

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

    // Parse node IDs (format: "service:<id>" or "database:<id>")
    const parseNodeId = (nodeId: string) => {
      const [type, ...rest] = nodeId.split(':');
      return { type: type as 'service' | 'database', id: rest.join(':') };
    };

    // React Flow normalizes connections so source always has a "source" handle,
    // regardless of drag direction. Use the tracked start node to preserve
    // the user's intended direction.
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

    // Skip server-to-server connections (shouldn't reach here normally,
    // since ServerGroupNode no longer renders handles when expanded).
    if (source.type !== 'service' && source.type !== 'database') return;
    if (target.type !== 'service' && target.type !== 'database') return;

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

  // Export
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showExportMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as HTMLElement)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showExportMenu]);

  useEffect(() => {
    if (!showConnectionsList) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (connectionsListRef.current && !connectionsListRef.current.contains(e.target as HTMLElement)) {
        setShowConnectionsList(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showConnectionsList]);

  const handleExportMermaid = useCallback(async () => {
    setShowExportMenu(false);
    try {
      const res = await exportDiagramMermaid(environmentId);
      downloadFile('topology.md', res.mermaid, 'text/markdown');
    } catch {
      // Silently fail
    }
  }, [environmentId]);

  const handleExportPng = useCallback(async () => {
    setShowExportMenu(false);
    const viewport = document.querySelector('.react-flow__viewport') as HTMLElement | null;
    if (!viewport) return;
    try {
      const dataUrl = await toPng(viewport, {
        backgroundColor: '#0f172a',
        pixelRatio: 2,
        skipFonts: true,
      });
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'topology.png';
      a.click();
    } catch {
      // Export failed silently
    }
  }, []);

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
    return map;
  }, [servers, databases]);

  const { nodes, serviceToServer, databaseToServer } = useMemo(
    () => buildNodes(servers, databases, collapsedServers, handleToggleCollapse, savedPositions),
    [servers, databases, collapsedServers, handleToggleCollapse, savedPositions]
  );

  const edges = useMemo(() => {
    const inferred = inferConnections(servers, databases);
    const merged = mergeConnections(inferred, manualConnections);
    const aggregated = aggregateCollapsedEdges(merged, collapsedServers, serviceToServer, databaseToServer);
    return topologyEdgesToReactFlow(aggregated, canInteract ? handleDeleteConnection : null);
  }, [servers, databases, manualConnections, collapsedServers, serviceToServer, databaseToServer, canInteract, handleDeleteConnection]);

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
  const isEmpty = servers.length === 0 && databases.length === 0;

  if (isEmpty) {
    return (
      <div className="panel">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-white">Environment Diagram</h2>
        </div>
        <EmptyState
          icon={NetworkIcon}
          message="No services discovered yet"
          description="Add servers and discover containers to see the topology diagram"
        />
      </div>
    );
  }

  const flowProps = {
    nodes: flowNodes,
    edges: flowEdges,
    onNodesChange: canInteract ? onNodesChange : undefined,
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
    <AddConnectionModal
      isOpen={showAddConnectionModal}
      onClose={() => setShowAddConnectionModal(false)}
      environmentId={environmentId}
      servers={servers}
      databases={databases}
      onConnectionCreated={(conn) => setManualConnections((prev) => [...prev, conn])}
    />
  ) : null;

  if (mode === 'fullscreen') {
    return (
      <>
        <style>{reactFlowDarkStyles}</style>
        <div className="fixed inset-0 bg-slate-900 z-50 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-white">Environment Diagram</h2>
              <span className="text-xs text-slate-400">
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
                    onToggle={() => setShowConnectionsList((v) => !v)}
                    menuRef={connectionsListRef}
                  />
                </>
              )}
              <div className="relative" ref={showExportMenu ? exportMenuRef : undefined}>
                <button
                  onClick={() => setShowExportMenu((v) => !v)}
                  className="p-1.5 text-slate-400 hover:text-white rounded"
                  title="Export"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </button>
                {showExportMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-lg py-1 z-50 min-w-[140px]">
                    <button onClick={handleExportMermaid} className="w-full text-left px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700">
                      Mermaid (.md)
                    </button>
                    <button onClick={handleExportPng} className="w-full text-left px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700">
                      PNG (.png)
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={() => setMode('expanded')}
                className="btn btn-sm btn-secondary"
                title="Exit fullscreen (Esc)"
              >
                Exit Fullscreen
              </button>
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
                className="!bg-slate-800 !border-slate-700"
              />
            </ReactFlow>
          </div>
          <div className="flex items-center gap-4 px-4 py-2 border-t border-slate-700 text-xs text-slate-400">
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-blue-400 inline-block rounded" />
              Auto-inferred
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-green-400 inline-block rounded" />
              Manual
            </div>
            {canInteract && (
              <div className="text-slate-500 ml-auto">
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
      <div className="panel">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-white">Environment Diagram</h2>
            <span className="text-xs text-slate-400">
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
                  onToggle={() => setShowConnectionsList((v) => !v)}
                  menuRef={connectionsListRef}
                />
              </>
            )}
            <div className="relative" ref={showExportMenu ? exportMenuRef : undefined}>
              <button
                onClick={() => setShowExportMenu((v) => !v)}
                className="p-1.5 text-slate-400 hover:text-white rounded"
                title="Export"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
              {showExportMenu && (
                <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-lg py-1 z-50 min-w-[140px]">
                  <button onClick={handleExportMermaid} className="w-full text-left px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700">
                    Mermaid (.md)
                  </button>
                  <button onClick={handleExportPng} className="w-full text-left px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700">
                    PNG (.png)
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={() => setMode(mode === 'compact' ? 'expanded' : 'compact')}
              className="p-1.5 text-slate-400 hover:text-white rounded"
              title={mode === 'compact' ? 'Expand' : 'Compact'}
            >
              {mode === 'compact' ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.5 3.5m11 5.5V4.5m0 4.5h4.5m-4.5 0l5.5-5.5M9 15v4.5M9 15H4.5M9 15l-5.5 5.5m11-5.5v4.5m0-4.5h4.5m-4.5 0l5.5 5.5" />
                </svg>
              )}
            </button>
            <button
              onClick={() => setMode('fullscreen')}
              className="p-1.5 text-slate-400 hover:text-white rounded"
              title="Fullscreen"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            </button>
          </div>
        </div>
        <div ref={containerRef} className={`${heightClass} rounded-lg overflow-hidden border border-slate-700`}>
          <ReactFlow {...flowProps}>
            <Background color="#334155" gap={20} size={1} />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        </div>
        {edges.length > 0 && (
          <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-blue-400 inline-block rounded" />
              Auto-inferred
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-green-400 inline-block rounded" />
              Manual
            </div>
            {canInteract && (
              <div className="text-slate-500 ml-auto hidden md:block">
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

function AddConnectionButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="p-1.5 text-slate-400 hover:text-white rounded"
      title="Add connection"
      aria-label="Add connection"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
    </button>
  );
}

function ConnectionsListButton({
  connections,
  nodeNameMap,
  onDelete,
  show,
  onToggle,
  menuRef,
}: {
  connections: ServiceConnection[];
  nodeNameMap: Map<string, string>;
  onDelete: (id: string) => void;
  show: boolean;
  onToggle: () => void;
  menuRef: React.Ref<HTMLDivElement>;
}) {
  if (connections.length === 0) return null;

  const resolveName = (type: string, id: string) =>
    nodeNameMap.get(`${type}:${id}`) || id.slice(0, 8);

  return (
    <div className="relative" ref={show ? menuRef : undefined}>
      <button
        onClick={onToggle}
        className="p-1.5 text-slate-400 hover:text-white rounded"
        title="Manage connections"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      </button>
      {show && (
        <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-lg py-1 z-50 min-w-[240px] max-h-[300px] overflow-y-auto">
          <div className="px-3 py-1.5 text-xs font-medium text-slate-400 border-b border-slate-700">
            Manual Connections ({connections.length})
          </div>
          {connections.map((conn) => (
            <div key={conn.id} className="flex items-center justify-between px-3 py-1.5 hover:bg-slate-700 group">
              <div className="flex items-center gap-1 text-sm text-slate-300 min-w-0">
                <span className="truncate max-w-[80px]" title={resolveName(conn.sourceType, conn.sourceId)}>
                  {resolveName(conn.sourceType, conn.sourceId)}
                </span>
                <svg className="w-3 h-3 text-slate-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
                <span className="truncate max-w-[80px]" title={resolveName(conn.targetType, conn.targetId)}>
                  {resolveName(conn.targetType, conn.targetId)}
                </span>
              </div>
              <button
                onClick={() => onDelete(conn.id)}
                className="p-0.5 text-slate-500 hover:text-red-400 rounded opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2"
                title="Delete connection"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
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
      <button
        onClick={onFitView}
        className="p-1.5 text-slate-400 hover:text-white rounded"
        title="Fit to view"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </button>
      <button
        onClick={onExpandAll}
        className="p-1.5 text-slate-400 hover:text-white rounded"
        title="Expand all servers"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <button
        onClick={onCollapseAll}
        className="p-1.5 text-slate-400 hover:text-white rounded"
        title="Collapse all servers"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </button>
    </>
  );
}

function NetworkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  );
}

export function TopologyDiagram(props: TopologyDiagramProps) {
  return (
    <ReactFlowProvider>
      <DiagramInner {...props} />
    </ReactFlowProvider>
  );
}
