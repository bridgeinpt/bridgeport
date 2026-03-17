import { format } from 'date-fns';
import type { ServiceHistoryEntry } from './types';
import { getHealthStatusColor } from './utils';
import { safeJsonParse } from '../../lib/helpers';

interface ActionHistoryProps {
  actionHistory: ServiceHistoryEntry[];
  showAllHistory: boolean;
  setShowAllHistory: (show: boolean) => void;
}

export function ActionHistory({
  actionHistory,
  showAllHistory,
  setShowAllHistory,
}: ActionHistoryProps) {
  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Action History</h3>
        {actionHistory.length > 5 && (
          <button
            onClick={() => setShowAllHistory(!showAllHistory)}
            className="text-sm text-primary-400 hover:text-primary-300"
          >
            {showAllHistory ? 'Show Less' : `Show All (${actionHistory.length})`}
          </button>
        )}
      </div>
      {actionHistory.length > 0 ? (
        <div className="space-y-2">
          {(showAllHistory ? actionHistory : actionHistory.slice(0, 5)).map((log) => {
            const details = safeJsonParse<Record<string, string> | null>(log.details, null);
            return (
              <div
                key={log.id}
                className={`flex items-center justify-between p-3 rounded-lg ${
                  log.success ? 'bg-slate-800/50' : 'bg-red-500/10'
                }`}
              >
                <div className="flex items-center gap-3">
                  {/* Action icon */}
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    log.action === 'deploy' ? 'bg-blue-500/20 text-blue-400' :
                    log.action === 'restart' ? 'bg-yellow-500/20 text-yellow-400' :
                    log.action === 'health_check' ? 'bg-green-500/20 text-green-400' :
                    log.action === 'update' ? 'bg-purple-500/20 text-purple-400' :
                    'bg-slate-600 text-slate-400'
                  }`}>
                    {log.action === 'deploy' && (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                    )}
                    {log.action === 'restart' && (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    )}
                    {log.action === 'health_check' && (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    )}
                    {log.action === 'update' && (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    )}
                    {log.action === 'create' && (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                      </svg>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium capitalize">{log.action.replace('_', ' ')}</span>
                      {!log.success && (
                        <span className="badge badge-error text-xs">failed</span>
                      )}
                      {log.action === 'deploy' && details?.imageTag && (
                        <span className="text-xs text-primary-400 font-mono">{details.imageTag}</span>
                      )}
                      {log.action === 'health_check' && details?.status && (
                        <span className={`badge text-xs ${getHealthStatusColor(details.healthStatus || details.status)}`}>
                          {details.healthStatus || details.status}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">
                      {log.user?.email || 'System'} • {format(new Date(log.createdAt), 'MMM d, HH:mm')}
                    </div>
                  </div>
                </div>
                {log.error && (
                  <div className="text-xs text-red-400 max-w-xs truncate" title={log.error}>
                    {log.error}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-slate-400">No actions recorded yet</p>
      )}
    </div>
  );
}
