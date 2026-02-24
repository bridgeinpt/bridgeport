import { useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from './store';
import { useAppStore } from './store';

type EventHandler = (data: unknown) => void;

// Global SSE connection singleton (shared across all hook instances)
let globalSource: EventSource | null = null;
let globalListeners = new Map<string, Set<EventHandler>>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let currentToken: string | null = null;
let currentEnvironmentId: string | undefined = undefined;
const MAX_RECONNECT_DELAY = 30000;

function getReconnectDelay(): number {
  return Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
}

function connectSSE(token: string, environmentId?: string): void {
  // If already connected with same params, skip
  if (
    globalSource &&
    globalSource.readyState !== EventSource.CLOSED &&
    currentToken === token &&
    currentEnvironmentId === environmentId
  ) {
    return;
  }

  // Close existing connection if params changed
  if (globalSource && globalSource.readyState !== EventSource.CLOSED) {
    globalSource.close();
    globalSource = null;
  }

  currentToken = token;
  currentEnvironmentId = environmentId;

  const params = new URLSearchParams();
  params.set('token', token);
  if (environmentId) params.set('environmentId', environmentId);

  globalSource = new EventSource(`/api/events?${params.toString()}`);

  globalSource.onopen = () => {
    reconnectAttempts = 0;
  };

  globalSource.onerror = () => {
    globalSource?.close();
    globalSource = null;

    // Auto-reconnect with exponential backoff
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectAttempts++;
      if (currentToken) {
        connectSSE(currentToken, currentEnvironmentId);
      }
    }, getReconnectDelay());
  };

  // Register message handlers for each event type
  const eventTypes = [
    'health_status',
    'deployment_progress',
    'notification',
    'metrics_updated',
    'container_discovery',
  ];
  for (const eventType of eventTypes) {
    globalSource.addEventListener(eventType, (event: MessageEvent) => {
      const handlers = globalListeners.get(eventType);
      if (handlers) {
        const data = JSON.parse(event.data);
        handlers.forEach((handler) => handler(data));
      }
    });
  }
}

function disconnectSSE(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (globalSource) {
    globalSource.close();
    globalSource = null;
  }
  currentToken = null;
  currentEnvironmentId = undefined;
  reconnectAttempts = 0;
}

/**
 * Subscribe to SSE events. The hook manages the global connection lifecycle.
 *
 * Usage:
 * ```tsx
 * useEventSource('health_status', (data) => {
 *   // data is { resourceType, resourceId, status, environmentId }
 *   refetchHealthData();
 * });
 * ```
 */
export function useEventSource(eventType: string, handler: EventHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const stableHandler = useCallback((data: unknown) => {
    handlerRef.current(data);
  }, []);

  useEffect(() => {
    const token = useAuthStore.getState().token;
    const selectedEnvironment = useAppStore.getState().selectedEnvironment;
    const environmentId = selectedEnvironment?.id;

    if (!token) return;

    // Register listener
    if (!globalListeners.has(eventType)) {
      globalListeners.set(eventType, new Set());
    }
    globalListeners.get(eventType)!.add(stableHandler);

    // Start connection if not already connected
    connectSSE(token, environmentId);

    return () => {
      // Unregister listener
      const handlers = globalListeners.get(eventType);
      if (handlers) {
        handlers.delete(stableHandler);
        if (handlers.size === 0) globalListeners.delete(eventType);
      }

      // Disconnect if no more listeners
      const totalListeners = Array.from(globalListeners.values()).reduce(
        (sum, set) => sum + set.size,
        0
      );
      if (totalListeners === 0) {
        disconnectSSE();
      }
    };
  }, [eventType, stableHandler]);
}
