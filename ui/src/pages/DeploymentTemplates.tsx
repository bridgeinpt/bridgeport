import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import {
  listDeploymentTemplates,
  deleteDeploymentTemplate,
  exportDeploymentTemplate,
  importDeploymentTemplate,
  type DeploymentTemplate,
} from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

export default function DeploymentTemplates() {
  const navigate = useNavigate();
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const [templates, setTemplates] = useState<DeploymentTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  // Import modal state
  const [showImport, setShowImport] = useState(false);
  const [importYaml, setImportYaml] = useState('');
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      listDeploymentTemplates(selectedEnvironment.id)
        .then(({ templates }) => setTemplates(templates))
        .catch((err) => toast.error(err.message))
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id, toast]);

  const handleDelete = async (template: DeploymentTemplate) => {
    if (!selectedEnvironment?.id) return;
    if (!confirm(`Delete template "${template.name}"? This cannot be undone.`)) return;

    try {
      await deleteDeploymentTemplate(selectedEnvironment.id, template.id);
      setTemplates((prev) => prev.filter((t) => t.id !== template.id));
      toast.success('Template deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const handleExport = async (template: DeploymentTemplate) => {
    if (!selectedEnvironment?.id) return;

    try {
      const { yaml } = await exportDeploymentTemplate(selectedEnvironment.id, template.id);
      // Create download
      const blob = new Blob([yaml], { type: 'text/yaml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${template.name.toLowerCase().replace(/\s+/g, '-')}.yaml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Template exported');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Export failed');
    }
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id || !importYaml.trim()) return;

    setImporting(true);
    try {
      const { template } = await importDeploymentTemplate(
        selectedEnvironment.id,
        importYaml,
        importName || undefined
      );
      setTemplates((prev) => [...prev, template]);
      setShowImport(false);
      setImportYaml('');
      setImportName('');
      toast.success('Template imported');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-slate-400">Select an environment to view deployment templates</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Reusable deployment plans for orchestrated multi-service deployments
        </p>
        <div className="flex gap-2">
          <button onClick={() => setShowImport(true)} className="btn btn-ghost">
            Import YAML
          </button>
          <Link to="/deployment-templates/new" className="btn btn-primary">
            Create Template
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="panel">
          <div className="animate-pulse space-y-4">
            <div className="h-16 bg-slate-700 rounded"></div>
            <div className="h-16 bg-slate-700 rounded"></div>
          </div>
        </div>
      ) : templates.length === 0 ? (
        <div className="panel text-center py-12">
          <TemplateIcon className="w-12 h-12 text-slate-500 mx-auto mb-4" />
          <p className="text-slate-400 mb-4">No deployment templates yet</p>
          <p className="text-slate-500 text-sm mb-4">
            Create reusable templates to deploy multiple services with consistent patterns
          </p>
          <div className="flex gap-2 justify-center">
            <button onClick={() => setShowImport(true)} className="btn btn-ghost">
              Import from YAML
            </button>
            <Link to="/deployment-templates/new" className="btn btn-primary">
              Create Your First Template
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {templates.map((template) => {
            let definition;
            try {
              definition = JSON.parse(template.definition);
            } catch {
              definition = { steps: [] };
            }
            const stepCount = countSteps(definition.steps || []);

            return (
              <div key={template.id} className="panel">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div className="p-3 bg-slate-800 rounded-lg">
                      <TemplateIcon className="w-6 h-6 text-primary-400" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-semibold text-white">{template.name}</h3>
                        {definition.parallelExecution && (
                          <span className="badge bg-blue-500/20 text-blue-400 text-xs">
                            Parallel
                          </span>
                        )}
                      </div>

                      {template.description && (
                        <p className="text-slate-400 text-sm mt-1">{template.description}</p>
                      )}

                      <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                        <span>
                          {stepCount.deploy} deploy step{stepCount.deploy !== 1 ? 's' : ''}
                        </span>
                        {stepCount.healthCheck > 0 && (
                          <span>
                            {stepCount.healthCheck} health check{stepCount.healthCheck !== 1 ? 's' : ''}
                          </span>
                        )}
                        <span>
                          Used {template.useCount} time{template.useCount !== 1 ? 's' : ''}
                        </span>
                        {template.lastUsedAt && (
                          <span>
                            Last used {formatDistanceToNow(new Date(template.lastUsedAt), { addSuffix: true })}
                          </span>
                        )}
                        <span>
                          Created by {template.createdBy?.email || 'unknown'}
                        </span>
                      </div>

                      {/* Recent executions */}
                      {template.deploymentPlans && template.deploymentPlans.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {template.deploymentPlans.slice(0, 3).map((plan) => (
                            <Link
                              key={plan.id}
                              to={`/deployment-plans/${plan.id}`}
                              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${
                                plan.status === 'completed'
                                  ? 'bg-green-500/20 text-green-400'
                                  : plan.status === 'failed'
                                  ? 'bg-red-500/20 text-red-400'
                                  : plan.status === 'running'
                                  ? 'bg-blue-500/20 text-blue-400'
                                  : 'bg-slate-700 text-slate-400'
                              }`}
                            >
                              {plan.imageTag && <span className="font-mono">{plan.imageTag}</span>}
                              <span>{plan.status.replace('_', ' ')}</span>
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => navigate(`/deployment-templates/${template.id}/execute`)}
                      className="btn btn-primary text-sm"
                    >
                      Execute
                    </button>
                    <Link
                      to={`/deployment-templates/${template.id}`}
                      className="btn btn-ghost text-sm"
                    >
                      Edit
                    </Link>
                    <button
                      onClick={() => handleExport(template)}
                      className="btn btn-ghost text-sm"
                    >
                      Export
                    </button>
                    <button
                      onClick={() => handleDelete(template)}
                      className="btn btn-ghost text-sm text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Import Modal */}
      {showImport && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-white mb-4">Import Template from YAML</h3>
            <form onSubmit={handleImport} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Name (optional, will be extracted from YAML if not provided)
                </label>
                <input
                  type="text"
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder="My Template"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">YAML Content</label>
                <textarea
                  value={importYaml}
                  onChange={(e) => setImportYaml(e.target.value)}
                  placeholder="Paste YAML template here..."
                  rows={16}
                  className="input font-mono text-sm"
                  required
                />
              </div>
              <div className="flex gap-2 justify-end pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowImport(false);
                    setImportYaml('');
                    setImportName('');
                  }}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={importing} className="btn btn-primary">
                  {importing ? 'Importing...' : 'Import'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

interface StepCounts {
  deploy: number;
  healthCheck: number;
  wait: number;
}

function countSteps(steps: { type: string; children?: { type: string }[] }[]): StepCounts {
  let counts = { deploy: 0, healthCheck: 0, wait: 0 };
  for (const step of steps) {
    if (step.type === 'deploy') counts.deploy++;
    else if (step.type === 'health_check') counts.healthCheck++;
    else if (step.type === 'wait') counts.wait++;
    else if (step.type === 'group' && step.children) {
      const childCounts = countSteps(step.children);
      counts.deploy += childCounts.deploy;
      counts.healthCheck += childCounts.healthCheck;
      counts.wait += childCounts.wait;
    }
  }
  return counts;
}

function TemplateIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
      />
    </svg>
  );
}
