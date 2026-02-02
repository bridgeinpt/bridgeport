import { format } from 'date-fns';
import type { Deployment } from './types';

interface DeploymentHistoryProps {
  deployments: Deployment[];
  expandedDeployment: string | null;
  setExpandedDeployment: (id: string | null) => void;
}

export function DeploymentHistory({
  deployments,
  expandedDeployment,
  setExpandedDeployment,
}: DeploymentHistoryProps) {
  return (
    <div className="card">
      <h3 className="text-lg font-semibold text-white mb-4">
        Deployment History
      </h3>
      {deployments.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                <th className="pb-3 font-medium">Tag</th>
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 font-medium">Triggered By</th>
                <th className="pb-3 font-medium">Started</th>
                <th className="pb-3 font-medium">Duration</th>
                <th className="pb-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {deployments.map((deployment) => (
                <>
                  <tr key={deployment.id} className="text-slate-300">
                    <td className="py-3 font-mono text-primary-400">
                      {deployment.imageTag}
                    </td>
                    <td className="py-3">
                      <span
                        className={`badge ${
                          deployment.status === 'success'
                            ? 'badge-success'
                            : deployment.status === 'failed'
                            ? 'badge-error'
                            : deployment.status === 'deploying'
                            ? 'badge-info'
                            : 'badge-warning'
                        }`}
                      >
                        {deployment.status}
                      </span>
                    </td>
                    <td className="py-3">{deployment.triggeredBy}</td>
                    <td className="py-3 text-sm">
                      {format(new Date(deployment.startedAt), 'MMM d, HH:mm')}
                    </td>
                    <td className="py-3 text-sm text-slate-400">
                      {deployment.completedAt
                        ? `${Math.round(
                            (new Date(deployment.completedAt).getTime() -
                              new Date(deployment.startedAt).getTime()) /
                              1000
                          )}s`
                        : '-'}
                    </td>
                    <td className="py-3 text-right">
                      {deployment.logs && (
                        <button
                          onClick={() =>
                            setExpandedDeployment(
                              expandedDeployment === deployment.id ? null : deployment.id
                            )
                          }
                          className={`text-sm ${
                            deployment.status === 'failed'
                              ? 'text-red-400 hover:text-red-300'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          {expandedDeployment === deployment.id ? 'Hide Logs' : 'View Logs'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedDeployment === deployment.id && deployment.logs && (
                    <tr key={`${deployment.id}-logs`}>
                      <td colSpan={6} className="p-0">
                        <pre className="p-4 bg-slate-950 text-xs text-slate-300 font-mono overflow-x-auto max-h-64 overflow-y-auto">
                          {deployment.logs}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-slate-400">No deployments yet</p>
      )}
    </div>
  );
}
