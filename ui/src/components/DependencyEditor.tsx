import { useState, useEffect } from 'react';
import { useToast } from './Toast';
import {
  getServiceDependencies,
  addServiceDependency,
  removeServiceDependency,
  getAvailableDependencies,
  type ServiceDependency,
  type ServiceDependent,
  type DependencyType,
  type Service,
} from '../lib/api';

interface DependencyEditorProps {
  serviceId: string;
  serviceName?: string;
  onUpdate?: () => void;
}

export function DependencyEditor({ serviceId, serviceName = 'This service', onUpdate }: DependencyEditorProps) {
  const toast = useToast();
  const [dependencies, setDependencies] = useState<ServiceDependency[]>([]);
  const [dependents, setDependents] = useState<ServiceDependent[]>([]);
  const [available, setAvailable] = useState<(Service & { server: { name: string } })[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addType, setAddType] = useState<DependencyType>('health_before');
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    loadDependencies();
  }, [serviceId]);

  const loadDependencies = async () => {
    setLoading(true);
    try {
      const [depsRes, availRes] = await Promise.all([
        getServiceDependencies(serviceId),
        getAvailableDependencies(serviceId),
      ]);
      setDependencies(depsRes.dependencies);
      setDependents(depsRes.dependents);
      setAvailable(availRes.services);
    } catch (error) {
      toast.error('Failed to load dependencies');
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (dependsOnId: string) => {
    setAddingId(dependsOnId);
    try {
      await addServiceDependency(serviceId, dependsOnId, addType);
      toast.success('Dependency added');
      await loadDependencies();
      onUpdate?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add dependency');
    } finally {
      setAddingId(null);
    }
  };

  const handleRemove = async (dependencyId: string) => {
    if (!confirm('Remove this dependency?')) return;
    setRemovingId(dependencyId);
    try {
      await removeServiceDependency(dependencyId);
      toast.success('Dependency removed');
      await loadDependencies();
      onUpdate?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove dependency');
    } finally {
      setRemovingId(null);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-2">
        <div className="h-8 bg-slate-700 rounded"></div>
        <div className="h-8 bg-slate-700 rounded"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Dependencies (services this service depends on) */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-medium text-slate-400">
            Depends On ({dependencies.length})
          </h4>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="text-sm text-primary-400 hover:text-primary-300"
          >
            {showAdd ? 'Cancel' : '+ Add Dependency'}
          </button>
        </div>

        {showAdd && (
          <div className="mb-4 p-3 bg-slate-800/50 rounded space-y-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Dependency Type</label>
              <select
                value={addType}
                onChange={(e) => setAddType(e.target.value as DependencyType)}
                className="input text-sm"
              >
                <option value="health_before">Health Before (wait for healthy)</option>
                <option value="deploy_after">Deploy After (no health wait)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">
                {serviceName} will deploy after:
              </label>
              {available.length === 0 ? (
                <p className="text-sm text-slate-500">No available services to depend on</p>
              ) : (
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {available.map((service) => (
                    <div
                      key={service.id}
                      className="flex items-center justify-between p-2 bg-slate-800 rounded"
                    >
                      <div>
                        <span className="text-white text-sm">{service.name}</span>
                        <span className="text-slate-500 text-xs ml-2">
                          on {service.server.name}
                        </span>
                      </div>
                      <button
                        onClick={() => handleAdd(service.id)}
                        disabled={addingId === service.id}
                        className="btn btn-sm btn-primary"
                      >
                        {addingId === service.id ? '...' : 'Add'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {dependencies.length === 0 ? (
          <p className="text-sm text-slate-500">No dependencies configured</p>
        ) : (
          <div className="space-y-2">
            {dependencies.map((dep) => (
              <div
                key={dep.id}
                className="flex items-center justify-between p-2 bg-slate-800/50 rounded"
              >
                <div className="flex items-center gap-2">
                  <span className={`badge text-xs ${
                    dep.type === 'health_before'
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-blue-500/20 text-blue-400'
                  }`}>
                    {dep.type === 'health_before' ? 'health' : 'deploy'}
                  </span>
                  <span className="text-white text-sm">{dep.dependsOn.name}</span>
                  {dep.dependsOn.server?.name && (
                    <span className="text-slate-500 text-xs">
                      on {dep.dependsOn.server.name}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => handleRemove(dep.id)}
                  disabled={removingId === dep.id}
                  className="text-slate-500 hover:text-red-400 text-sm"
                >
                  {removingId === dep.id ? '...' : '×'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dependents (services that depend on this service) */}
      {dependents.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-slate-400 mb-2">
            Required By ({dependents.length})
          </h4>
          <div className="space-y-2">
            {dependents.map((dep) => (
              <div
                key={dep.id}
                className="flex items-center gap-2 p-2 bg-slate-800/30 rounded text-sm"
              >
                <span className={`badge text-xs ${
                  dep.type === 'health_before'
                    ? 'bg-green-500/20 text-green-400'
                    : 'bg-blue-500/20 text-blue-400'
                }`}>
                  {dep.type === 'health_before' ? 'health' : 'deploy'}
                </span>
                <span className="text-slate-300">{dep.dependent.name}</span>
                {dep.dependent.server?.name && (
                  <span className="text-slate-500 text-xs">
                    on {dep.dependent.server.name}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
