import { formatDistanceToNow } from 'date-fns';
import type { ServiceWithServer, UpdateCheckResult } from './types';

interface DeployCardProps {
  service: ServiceWithServer;
  imageTag: string;
  setImageTag: (tag: string) => void;
  deploying: boolean;
  deployError: string | null;
  setDeployError: (error: string | null) => void;
  checkingUpdates: boolean;
  updateCheckResult: UpdateCheckResult | null;
  togglingAutoUpdate: boolean;
  onDeploy: () => void;
  onCheckUpdates: () => void;
  onToggleAutoUpdate: () => void;
}

export function DeployCard({
  service,
  imageTag,
  setImageTag,
  deploying,
  deployError,
  setDeployError,
  checkingUpdates,
  updateCheckResult,
  togglingAutoUpdate,
  onDeploy,
  onCheckUpdates,
  onToggleAutoUpdate,
}: DeployCardProps) {
  return (
    <div className="col-span-2 card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Deploy</h3>
        {service.containerImage?.registryConnectionId && (
          <button
            onClick={onCheckUpdates}
            disabled={checkingUpdates}
            className="btn btn-ghost text-sm"
          >
            {checkingUpdates ? 'Checking...' : 'Check for Updates'}
          </button>
        )}
      </div>
      <div className="space-y-4">
        {/* Image info */}
        <div className="grid grid-cols-2 gap-4 p-3 bg-slate-800/50 rounded-lg">
          <div>
            <dt className="text-xs text-slate-500 uppercase tracking-wide">Image Name</dt>
            <dd className="text-white font-mono text-sm mt-0.5">
              {service.containerImage?.imageName || <span className="text-slate-500 italic">Not set</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 uppercase tracking-wide">Image Tag</dt>
            <dd className="text-white font-mono text-sm mt-0.5">
              {service.imageTag || <span className="text-slate-500 italic">Not set</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 uppercase tracking-wide">Registry</dt>
            <dd className="text-white text-sm mt-0.5">
              {service.containerImage?.registryConnection ? (
                <span className="text-primary-400">{service.containerImage.registryConnection.name}</span>
              ) : (
                <span className="text-slate-500 italic">Not linked</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 uppercase tracking-wide">Current Image</dt>
            <dd className="text-primary-400 font-mono text-sm mt-0.5 break-all">
              {service.containerImage?.imageName && service.imageTag ? (
                `${service.containerImage?.imageName}:${service.imageTag}`
              ) : (
                <span className="text-slate-500 italic">Not configured</span>
              )}
            </dd>
          </div>
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1">
            Deploy Tag
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={imageTag}
              onChange={(e) => setImageTag(e.target.value)}
              placeholder="latest"
              className="input flex-1"
            />
            <button
              onClick={onDeploy}
              disabled={deploying}
              className="btn btn-primary"
            >
              {deploying ? 'Deploying...' : 'Deploy'}
            </button>
          </div>
        </div>

        {/* Auto-update toggle */}
        {service.containerImage?.registryConnectionId && (
          <div className="flex items-center justify-between pt-4 border-t border-slate-700">
            <div>
              <p className="text-white font-medium">Auto-update</p>
              <p className="text-sm text-slate-400">
                Automatically deploy when new versions are available
              </p>
            </div>
            <button
              onClick={onToggleAutoUpdate}
              disabled={togglingAutoUpdate}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                service.autoUpdate ? 'bg-primary-600' : 'bg-slate-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  service.autoUpdate ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        )}

        {/* Last update check */}
        {service.lastUpdateCheckAt && (
          <p className="text-xs text-slate-500">
            Last checked {formatDistanceToNow(new Date(service.lastUpdateCheckAt), { addSuffix: true })}
          </p>
        )}

        {/* Update check result */}
        {updateCheckResult && (
          <div className={`text-sm ${updateCheckResult.hasUpdate ? 'text-blue-400' : 'text-green-400'}`}>
            {updateCheckResult.hasUpdate
              ? `Update available: ${updateCheckResult.bestTag || 'new digest'}`
              : 'No updates available'}
          </div>
        )}

        {/* Deploy error */}
        {deployError && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <div className="flex items-start gap-2">
              <svg className="w-5 h-5 text-red-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="flex-1">
                <p className="text-red-400 font-medium">Deployment Failed</p>
                <p className="text-red-300/80 text-sm mt-1">{deployError}</p>
              </div>
              <button
                onClick={() => setDeployError(null)}
                className="text-red-400 hover:text-red-300"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
