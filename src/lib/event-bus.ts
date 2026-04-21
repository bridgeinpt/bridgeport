import { EventEmitter } from 'events';

export type BRIDGEPORTEvent =
  | { type: 'health_status'; data: { resourceType: 'server' | 'service'; resourceId: string; status: string; environmentId: string } }
  | { type: 'deployment_progress'; data: { deploymentId?: string; planId?: string; serviceId: string; status: string; environmentId: string } }
  | { type: 'notification'; data: { userId: string; count: number } }
  | { type: 'metrics_updated'; data: { serverId: string; environmentId: string } }
  | { type: 'container_discovery'; data: { serverId: string; environmentId: string } };

class EventBus extends EventEmitter {
  emitEvent(event: BRIDGEPORTEvent): void {
    this.emit('event', event);
  }
}

export const eventBus = new EventBus();
// Set high listener limit since each SSE client adds a listener
eventBus.setMaxListeners(100);
