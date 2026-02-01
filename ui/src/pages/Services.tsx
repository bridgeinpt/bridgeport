import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { getEnvironment, type Service, type ExposedPort } from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

interface ServiceWithServer extends Service {
  serverName: string;
}

function parseExposedPorts(portsJson: string | null): ExposedPort[] {
  if (!portsJson) return [];
  try {
    return JSON.parse(portsJson);
  } catch {
    return [];
  }
}

function formatPorts(ports: ExposedPort[], maxDisplay = 2): string {
  if (ports.length === 0) return '-';
  const displayed = ports.slice(0, maxDisplay).map(p =>
    p.host ? `${p.host}:${p.container}` : `${p.container}`
  );
  if (ports.length > maxDisplay) {
    displayed.push(`+${ports.length - maxDisplay}`);
  }
  return displayed.join(', ');
}

function getContainerStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'badge-success';
    case 'stopped':
    case 'exited':
    case 'dead':
      return 'badge-error';
    case 'restarting':
    case 'paused':
    case 'created':
      return 'badge-warning';
    default:
      return 'badge-warning';
  }
}

function getHealthStatusColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'badge-success';
    case 'unhealthy':
      return 'badge-error';
    case 'none':
      return 'bg-slate-600 text-slate-300';
    default:
      return 'badge-warning';
  }
}

export default function Services() {
  const { selectedEnvironment } = useAppStore();
  const [services, setServices] = useState<ServiceWithServer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      getEnvironment(selectedEnvironment.id)
        .then(({ environment }) => {
          const allServices: ServiceWithServer[] = [];
          environment.servers.forEach((server) => {
            server.services.forEach((service) => {
              allServices.push({
                ...service,
                serverName: server.name,
              });
            });
          });
          setServices(allServices);
        })
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id]);

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-32 bg-slate-700 rounded mb-8"></div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Services</h1>
          <p className="text-slate-400">
            All services in {selectedEnvironment?.name}
          </p>
        </div>
      </div>

      <div className="card">
        {services.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                  <th className="pb-3 font-medium">Service</th>
                  <th className="pb-3 font-medium">Server</th>
                  <th className="pb-3 font-medium">Image</th>
                  <th className="pb-3 font-medium">Ports</th>
                  <th className="pb-3 font-medium">Container</th>
                  <th className="pb-3 font-medium">Health</th>
                  <th className="pb-3 font-medium">Last Checked</th>
                  <th className="pb-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {services.map((service) => {
                  const ports = parseExposedPorts(service.exposedPorts);
                  return (
                    <tr key={service.id} className="text-slate-300">
                      <td className="py-4">
                        <Link
                          to={`/services/${service.id}`}
                          className="text-white hover:text-primary-400 font-medium"
                        >
                          {service.name}
                        </Link>
                        <p className="text-sm text-slate-400 font-mono">
                          {service.containerName}
                        </p>
                      </td>
                      <td className="py-4">
                        <Link
                          to={`/servers/${service.serverId}`}
                          className="text-slate-300 hover:text-primary-400"
                        >
                          {service.serverName}
                        </Link>
                      </td>
                      <td className="py-4 font-mono text-sm">
                        <span className="text-slate-400">
                          {service.imageName.split('/').pop()}
                        </span>
                        :<span className="text-primary-400">{service.imageTag}</span>
                      </td>
                      <td className="py-4 font-mono text-sm text-slate-400">
                        {formatPorts(ports)}
                      </td>
                      <td className="py-4">
                        <span className={`badge ${getContainerStatusColor(service.containerStatus || service.status)}`}>
                          {service.containerStatus || service.status}
                        </span>
                      </td>
                      <td className="py-4">
                        <span className={`badge ${getHealthStatusColor(service.healthStatus || 'unknown')}`}>
                          {service.healthStatus || 'unknown'}
                        </span>
                      </td>
                      <td className="py-4 text-sm text-slate-400">
                        {service.lastCheckedAt
                          ? formatDistanceToNow(new Date(service.lastCheckedAt), {
                              addSuffix: true,
                            })
                          : 'Never'}
                      </td>
                      <td className="py-4 text-right">
                        <Link
                          to={`/services/${service.id}`}
                          className="text-primary-400 hover:text-primary-300 text-sm"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-12">
            <p className="text-slate-400">No services discovered</p>
            <p className="text-sm text-slate-500 mt-2">
              Go to a server and click "Discover Containers" to find services
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
