import { useState } from 'react';
import { useToast } from './Toast';
import { updateServiceHealthConfig, type ServiceHealthConfig } from '../lib/api';

interface HealthConfigEditorProps {
  serviceId: string;
  initialConfig: {
    healthWaitMs: number;
    healthRetries: number;
    healthIntervalMs: number;
  };
  onUpdate?: () => void;
}

export function HealthConfigEditor({
  serviceId,
  initialConfig,
  onUpdate,
}: HealthConfigEditorProps) {
  const toast = useToast();
  const [config, setConfig] = useState<ServiceHealthConfig>(initialConfig);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const handleChange = (field: keyof ServiceHealthConfig, value: number) => {
    setConfig({ ...config, [field]: value });
    setHasChanges(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateServiceHealthConfig(serviceId, config);
      toast.success('Health config saved');
      setHasChanges(false);
      onUpdate?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setConfig(initialConfig);
    setHasChanges(false);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-xs text-slate-500 mb-1">
            Wait Time (ms)
          </label>
          <input
            type="number"
            value={config.healthWaitMs}
            onChange={(e) => handleChange('healthWaitMs', parseInt(e.target.value) || 0)}
            min={0}
            step={1000}
            className="input text-sm"
          />
          <p className="text-xs text-slate-600 mt-1">
            Initial wait after deploy
          </p>
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1">
            Retries
          </label>
          <input
            type="number"
            value={config.healthRetries}
            onChange={(e) => handleChange('healthRetries', parseInt(e.target.value) || 1)}
            min={1}
            max={20}
            className="input text-sm"
          />
          <p className="text-xs text-slate-600 mt-1">
            Health check attempts
          </p>
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1">
            Interval (ms)
          </label>
          <input
            type="number"
            value={config.healthIntervalMs}
            onChange={(e) => handleChange('healthIntervalMs', parseInt(e.target.value) || 0)}
            min={0}
            step={1000}
            className="input text-sm"
          />
          <p className="text-xs text-slate-600 mt-1">
            Time between retries
          </p>
        </div>
      </div>

      {/* Summary */}
      <div className="text-xs text-slate-500 bg-slate-800/50 rounded p-3">
        <p>
          During orchestrated deployments, this service will:
        </p>
        <ul className="list-disc list-inside mt-1 space-y-0.5">
          <li>Wait {((config.healthWaitMs || 0) / 1000).toFixed(1)}s after deployment</li>
          <li>Check health up to {config.healthRetries} times</li>
          <li>Wait {((config.healthIntervalMs || 0) / 1000).toFixed(1)}s between checks</li>
          <li>
            Total max time:{' '}
            {(
              ((config.healthWaitMs || 0) +
                ((config.healthRetries || 1) - 1) * (config.healthIntervalMs || 0)) /
              1000
            ).toFixed(1)}s
          </li>
        </ul>
      </div>

      {hasChanges && (
        <div className="flex gap-2 justify-end">
          <button onClick={handleReset} className="btn btn-ghost text-sm">
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn btn-primary text-sm"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      )}
    </div>
  );
}

// Compact inline display
interface HealthConfigDisplayProps {
  config: {
    healthWaitMs: number;
    healthRetries: number;
    healthIntervalMs: number;
  };
}

export function HealthConfigDisplay({ config }: HealthConfigDisplayProps) {
  return (
    <div className="flex items-center gap-3 text-xs text-slate-500">
      <span>
        Wait: {(config.healthWaitMs / 1000).toFixed(1)}s
      </span>
      <span>•</span>
      <span>
        Retries: {config.healthRetries}
      </span>
      <span>•</span>
      <span>
        Interval: {(config.healthIntervalMs / 1000).toFixed(1)}s
      </span>
    </div>
  );
}
