import { useState, useMemo } from 'react';
import { Modal } from '../Modal';
import { createConnection, type ServerWithServices, type Database, type ServiceConnection } from '../../lib/api';

interface AddConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  servers: ServerWithServices[];
  databases: Database[];
  onConnectionCreated: (connection: ServiceConnection) => void;
}

interface NodeOption {
  type: 'service' | 'database';
  id: string;
  label: string;
  group: string;
}

const PROTOCOLS = ['tcp', 'http', 'grpc', 'custom'] as const;

export function AddConnectionModal({
  isOpen,
  onClose,
  environmentId,
  servers,
  databases,
  onConnectionCreated,
}: AddConnectionModalProps) {
  const [sourceKey, setSourceKey] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const [port, setPort] = useState('');
  const [protocol, setProtocol] = useState('');
  const [label, setLabel] = useState('');
  const [direction, setDirection] = useState<'forward' | 'none'>('forward');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Build flat node list grouped by server
  const nodeOptions = useMemo<NodeOption[]>(() => {
    const options: NodeOption[] = [];
    for (const server of servers) {
      for (const service of server.services) {
        options.push({
          type: 'service',
          id: service.id,
          label: service.name,
          group: `Server: ${server.name}`,
        });
      }
    }
    for (const db of databases) {
      const serverName = servers.find((s) => s.id === db.serverId)?.name;
      options.push({
        type: 'database',
        id: db.id,
        label: db.name,
        group: serverName ? `Server: ${serverName}` : 'External',
      });
    }
    return options;
  }, [servers, databases]);

  const targetOptions = useMemo(() => {
    return nodeOptions.filter((n) => `${n.type}:${n.id}` !== sourceKey);
  }, [nodeOptions, sourceKey]);

  const resetForm = () => {
    setSourceKey('');
    setTargetKey('');
    setPort('');
    setProtocol('');
    setLabel('');
    setDirection('forward');
    setError(null);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceKey || !targetKey) return;

    const [sourceType, sourceId] = sourceKey.split(':') as ['service' | 'database', string];
    const [targetType, targetId] = targetKey.split(':') as ['service' | 'database', string];

    setSubmitting(true);
    setError(null);

    try {
      const result = await createConnection({
        environmentId,
        sourceType,
        sourceId,
        targetType,
        targetId,
        port: port ? parseInt(port, 10) : null,
        protocol: protocol || null,
        label: label || null,
        direction,
      });
      onConnectionCreated(result.connection);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create connection');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Add Connection" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Source */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Source</label>
          <select
            value={sourceKey}
            onChange={(e) => {
              setSourceKey(e.target.value);
              // Clear target if same as new source
              if (targetKey === e.target.value) setTargetKey('');
            }}
            className="input w-full"
            required
          >
            <option value="">Select source...</option>
            {nodeOptions.map((opt) => (
              <option key={`${opt.type}:${opt.id}`} value={`${opt.type}:${opt.id}`}>
                [{opt.type === 'service' ? 'Service' : 'Database'}] {opt.label} ({opt.group})
              </option>
            ))}
          </select>
        </div>

        {/* Target */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Target</label>
          <select
            value={targetKey}
            onChange={(e) => setTargetKey(e.target.value)}
            className="input w-full"
            required
          >
            <option value="">Select target...</option>
            {targetOptions.map((opt) => (
              <option key={`${opt.type}:${opt.id}`} value={`${opt.type}:${opt.id}`}>
                [{opt.type === 'service' ? 'Service' : 'Database'}] {opt.label} ({opt.group})
              </option>
            ))}
          </select>
        </div>

        {/* Port & Protocol */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Port</label>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="input w-full"
              placeholder="e.g. 5432"
              min={1}
              max={65535}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Protocol</label>
            <select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
              className="input w-full"
            >
              <option value="">None</option>
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>{p.toUpperCase()}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Label */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="input w-full"
            placeholder="e.g. Primary DB"
          />
        </div>

        {/* Direction */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Direction</label>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
              <input
                type="radio"
                name="direction"
                value="forward"
                checked={direction === 'forward'}
                onChange={() => setDirection('forward')}
                className="text-primary-500"
              />
              Directed (source &rarr; target)
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
              <input
                type="radio"
                name="direction"
                value="none"
                checked={direction === 'none'}
                onChange={() => setDirection('none')}
                className="text-primary-500"
              />
              Undirected
            </label>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={handleClose} className="btn btn-secondary">
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !sourceKey || !targetKey}
            className="btn btn-primary"
          >
            {submitting ? 'Creating...' : 'Add Connection'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
