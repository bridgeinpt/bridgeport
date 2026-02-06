import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

interface NodePopoverProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  data: {
    name: string;
    type: 'service' | 'database';
    id: string;
    image?: string;
    dbType?: string;
    status: string;
    healthStatus?: string;
    ports?: Array<{ host: number | null; container: number; protocol: string }>;
  };
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'running':
    case 'healthy':
      return 'bg-green-500';
    case 'unhealthy':
    case 'stopped':
    case 'exited':
    case 'dead':
      return 'bg-red-500';
    default:
      return 'bg-yellow-500';
  }
}

function getStatusLabel(status: string, healthStatus?: string): string {
  if (healthStatus && healthStatus !== 'none' && healthStatus !== 'unknown') {
    return healthStatus;
  }
  return status;
}

export function NodePopover({ isOpen, onClose, position, data }: NodePopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid immediate close from the click that opened it
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const displayStatus = getStatusLabel(data.status, data.healthStatus);
  const detailPath = data.type === 'service' ? `/services/${data.id}` : `/databases/${data.id}`;

  return (
    <div
      ref={ref}
      className="fixed bg-slate-800 border border-slate-600 rounded-lg shadow-lg p-3 min-w-[200px] z-[100]"
      style={{ left: position.x, top: position.y }}
    >
      <p className="text-sm font-semibold text-white mb-1">{data.name}</p>
      {data.image && (
        <p className="text-xs text-slate-400 font-mono truncate mb-1">{data.image}</p>
      )}
      {data.dbType && (
        <p className="text-xs text-slate-400 font-mono mb-1">{data.dbType}</p>
      )}
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-2 h-2 rounded-full ${getStatusColor(displayStatus)}`} />
        <span className="text-xs text-slate-300 capitalize">{displayStatus}</span>
      </div>
      {data.ports && data.ports.length > 0 && (
        <div className="mb-1">
          <p className="text-xs text-slate-500">Ports:</p>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {data.ports.map((p, i) => (
              <span key={i} className="text-xs font-mono text-slate-300 bg-slate-700 px-1.5 py-0.5 rounded">
                {p.host ? `${p.host}:` : ''}{p.container}/{p.protocol}
              </span>
            ))}
          </div>
        </div>
      )}
      <Link
        to={detailPath}
        className="text-xs text-primary-400 hover:text-primary-300 mt-1 inline-block"
      >
        View Details &rarr;
      </Link>
    </div>
  );
}
