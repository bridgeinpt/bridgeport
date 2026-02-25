import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    agentEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

import { logAgentEvent, getAgentEvents } from './agent-events.js';

describe('agent-events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('logAgentEvent', () => {
    it('should create an agent event with all fields', async () => {
      mockPrisma.agentEvent.create.mockResolvedValue({});

      await logAgentEvent({
        serverId: 'server-1',
        eventType: 'deploy_started',
        status: 'deploying',
        message: 'Agent deployment initiated',
        details: { serverUrl: 'http://localhost:3000' },
      });

      expect(mockPrisma.agentEvent.create).toHaveBeenCalledWith({
        data: {
          serverId: 'server-1',
          eventType: 'deploy_started',
          status: 'deploying',
          message: 'Agent deployment initiated',
          details: JSON.stringify({ serverUrl: 'http://localhost:3000' }),
        },
      });
    });

    it('should set details to null when not provided', async () => {
      mockPrisma.agentEvent.create.mockResolvedValue({});

      await logAgentEvent({
        serverId: 'server-1',
        eventType: 'deploy_success',
      });

      expect(mockPrisma.agentEvent.create).toHaveBeenCalledWith({
        data: {
          serverId: 'server-1',
          eventType: 'deploy_success',
          status: undefined,
          message: undefined,
          details: null,
        },
      });
    });

    it('should handle all event types', async () => {
      mockPrisma.agentEvent.create.mockResolvedValue({});

      const eventTypes = [
        'deploy_started',
        'deploy_success',
        'deploy_failed',
        'token_regenerated',
        'status_change',
      ] as const;

      for (const eventType of eventTypes) {
        await logAgentEvent({ serverId: 'server-1', eventType });
      }

      expect(mockPrisma.agentEvent.create).toHaveBeenCalledTimes(5);
    });
  });

  describe('getAgentEvents', () => {
    it('should return events for a server with default limit', async () => {
      const mockEvents = [
        { id: '1', eventType: 'deploy_success', status: null, message: 'ok', details: null, createdAt: new Date() },
        { id: '2', eventType: 'deploy_started', status: null, message: 'starting', details: null, createdAt: new Date() },
      ];
      mockPrisma.agentEvent.findMany.mockResolvedValue(mockEvents);

      const result = await getAgentEvents('server-1');

      expect(result).toEqual(mockEvents);
      expect(mockPrisma.agentEvent.findMany).toHaveBeenCalledWith({
        where: { serverId: 'server-1' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    });

    it('should respect custom limit', async () => {
      mockPrisma.agentEvent.findMany.mockResolvedValue([]);

      await getAgentEvents('server-1', 5);

      expect(mockPrisma.agentEvent.findMany).toHaveBeenCalledWith({
        where: { serverId: 'server-1' },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
    });
  });
});
