import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
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
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ServerGroupNode } from './ServerGroupNode';
import { ServiceNode, type ServiceNodeData } from './ServiceNode';
import { DatabaseNode, type DatabaseNodeData } from './DatabaseNode';
import type { ServerWithServices, Database, UserRole, ExposedPort, ServiceConnection, DiagramLayoutPositions } from '../../lib/api';
import { listConnections, createConnection, deleteConnection, getDiagramLayout, saveDiagramLayout, exportDiagramMermaid } from '../../lib/api';
import { inferConnections, mergeConnections, aggregateCollapsedEdges, type TopologyEdge } from '../../lib/topology';
import { EmptyState } from '../EmptyState';
import { toPng } from 'html-to-image';

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
}: EdgeProps) {
  const edgeData = data as { edgeType?: string; label?: string | null; port?: number | null; protocol?: string | null; manualId?: string; onDelete?: (id: string) => void } | undefined;
  const isAuto = edgeData?.edgeType === 'auto';
  const strokeColor = isAuto ? '#60a5fa' : '#4ade80';

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ stroke: strokeColor, strokeWidth: 2 }} markerEnd={markerEnd} />
      {(edgeData?.label || edgeData?.manualId) && (
        <EdgeLabelRenderer>
          <div
            className="absolute flex items-center gap-1 text-[10px] bg-slate-800 border border-slate-600 px-1.5 py-0.5 rounded text-slate-300 pointer-events-auto"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            title={[edgeData?.port && `Port: ${edgeData.port}`, edgeData?.protocol && `Protocol: ${edgeData.protocol}`, edgeData?.label].filter(Boolean).join(' | ')}
          >
            {edgeData?.label && <span>{edgeData.label}</span>}
            {edgeData?.manualId && edgeData?.onDelete && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  edgeData.onDelete!(edgeData.manualId!);
                }}
                className="text-slate-500 hover:text-red-400 ml-0.5"
                title="Delete connection"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

function parseExposedPorts(portsJson: string | null): ExposedPort[] {
  if (!portsJson) return [];
  try {
    return JSON.parse(portsJson);
  } catch {
    return [];
  }
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
            status: service.status,
            healthStatus: service.healthStatus,
            containerStatus: service.containerStatus,
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
  onDeleteManual?: (connectionId: string) => void,
): Edge[] {
  return topologyEdges.map((te) => {
    // Extract manual connection ID from edge ID (format: "manual:<connectionId>")
    const manualId = te.type === 'manual' && te.id.startsWith('manual:') ? te.id.replace('manual:', '') : undefined;

    return {
      id: te.id,
      source: te.source,
      target: te.target,
      type: 'topology',
      markerEnd: te.directed
        ? { type: MarkerType.ArrowClosed, color: te.type === 'auto' ? '#60a5fa' : '#4ade80', width: 16, height: 16 }
        : undefined,
      data: {
        edgeType: te.type,
        label: te.label,
        port: te.port,
        protocol: te.protocol,
        manualId,
        onDelete: onDeleteManual,
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
`;

function DiagramInner({ servers, databases, environmentId, userRole }: TopologyDiagramProps) {
  const [mode, setMode] = useState<DiagramMode>('compact');
  const [collapsedServers, setCollapsedServers] = useState<Set<string>>(new Set());
  const [manualConnections, setManualConnections] = useState<ServiceConnection[]>([]);
  const [savedPositions, setSavedPositions] = useState<DiagramLayoutPositions | null>(null);
  const reactFlowInstance = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canInteract = userRole === 'admin' || userRole === 'operator';

  // Fetch manual connections
  useEffect(() => {
    if (!environmentId) return;
    listConnections(environmentId)
      .then((res) => setManualConnections(res.connections || []))
      .catch(() => setManualConnections([]));
  }, [environmentId]);

  // Fetch saved layout
  useEffect(() => {
    if (!environmentId) return;
    getDiagramLayout(environmentId)
      .then((res) => {
        if (res.layout?.positions) {
          setSavedPositions(res.layout.positions);
        }
      })
      .catch(() => {});
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

  // Layout persistence: debounced save on drag end
  const handleNodeDragStop: OnNodeDrag = useCallback((_event, _node) => {
    if (!canInteract || !environmentId) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      const currentNodes = reactFlowInstance.getNodes();
      const positions: DiagramLayoutPositions = {};
      for (const n of currentNodes) {
        // Only save server and standalone (no parent) node positions
        if (!n.parentId) {
          positions[n.id] = { x: n.position.x, y: n.position.y };
        }
      }
      saveDiagramLayout(environmentId, positions).catch(() => {});
    }, 1000);
  }, [canInteract, environmentId, reactFlowInstance]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const handleDeleteConnection = useCallback(async (connectionId: string) => {
    try {
      await deleteConnection(connectionId);
      setManualConnections((prev) => prev.filter((c) => c.id !== connectionId));
    } catch {
      // Silently fail - the connection may have already been deleted
    }
  }, []);

  // Handle on-diagram edge creation
  const handleConnect: OnConnect = useCallback(async (connection: Connection) => {
    if (!canInteract || !connection.source || !connection.target) return;

    // Parse node IDs (format: "service:<id>" or "database:<id>")
    const parseNodeId = (nodeId: string) => {
      const [type, ...rest] = nodeId.split(':');
      return { type: type as 'service' | 'database', id: rest.join(':') };
    };

    const source = parseNodeId(connection.source);
    const target = parseNodeId(connection.target);

    // Skip server-to-server connections
    if (source.type !== 'service' && source.type !== 'database') return;
    if (target.type !== 'service' && target.type !== 'database') return;

    try {
      const res = await createConnection({
        environmentId,
        sourceType: source.type,
        sourceId: source.id,
        targetType: target.type,
        targetId: target.id,
        direction: 'forward',
      });
      // Backend returns connection directly (not wrapped)
      const conn = (res as unknown as ServiceConnection).id ? (res as unknown as ServiceConnection) : (res as { connection: ServiceConnection }).connection;
      setManualConnections((prev) => [...prev, conn]);
    } catch {
      // Connection creation failed (duplicate, invalid, etc.)
    }
  }, [canInteract, environmentId]);

  // ESC to exit fullscreen
  useEffect(() => {
    if (mode !== 'fullscreen') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMode('expanded');
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mode]);

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

  const { nodes, serviceToServer, databaseToServer } = useMemo(
    () => buildNodes(servers, databases, collapsedServers, handleToggleCollapse, savedPositions),
    [servers, databases, collapsedServers, handleToggleCollapse, savedPositions]
  );

  const edges = useMemo(() => {
    const inferred = inferConnections(servers, databases);
    const merged = mergeConnections(inferred, manualConnections);
    const aggregated = aggregateCollapsedEdges(merged, collapsedServers, serviceToServer, databaseToServer);
    return topologyEdgesToReactFlow(aggregated, canInteract ? handleDeleteConnection : undefined);
  }, [servers, databases, manualConnections, collapsedServers, serviceToServer, databaseToServer, canInteract, handleDeleteConnection]);

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(nodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(edges);

  useEffect(() => { setFlowNodes(nodes); }, [nodes, setFlowNodes]);
  useEffect(() => { setFlowEdges(edges); }, [edges, setFlowEdges]);

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
    onEdgesChange,
    onNodeDragStop: canInteract ? handleNodeDragStop : undefined,
    nodeTypes,
    edgeTypes,
    fitView: true,
    fitViewOptions: { padding: 0.2 },
    onConnect: canInteract ? handleConnect : undefined,
    nodesDraggable: canInteract,
    nodesConnectable: canInteract,
    proOptions: { hideAttribution: true },
  };

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
          </div>
        </div>
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
          </div>
        )}
      </div>
    </>
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
