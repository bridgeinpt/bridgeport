import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import {
  getDeploymentTemplate,
  createDeploymentTemplate,
  updateDeploymentTemplate,
  previewDeploymentTemplate,
  executeDeploymentTemplate,
  listServiceTypes,
  listServers,
  type DeploymentTemplate,
  type TemplateStep,
  type TemplateDefinition,
  type PlanPreview,
  type Service,
  type ServiceType,
} from '../lib/api';
import DeploymentPreview from '../components/DeploymentPreview';

type EditorTab = 'visual' | 'yaml';

interface EditableStep extends TemplateStep {
  id: string; // For drag-and-drop
}

export default function DeploymentTemplateEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const isNew = id === 'new';
  const isExecuteMode = window.location.pathname.endsWith('/execute');

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [template, setTemplate] = useState<DeploymentTemplate | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parallelExecution, setParallelExecution] = useState(false);
  const [steps, setSteps] = useState<EditableStep[]>([]);

  // YAML editor state
  const [activeTab, setActiveTab] = useState<EditorTab>('visual');
  const [yamlContent, setYamlContent] = useState('');
  const [yamlError] = useState<string | null>(null);

  // Preview state
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [previewTag] = useState('latest');
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Execute state
  const [executing, setExecuting] = useState(false);
  const [executeTag, setExecuteTag] = useState('latest');

  // Services for selector autocomplete
  const [services, setServices] = useState<Service[]>([]);
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>([]);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      // Load services from all servers
      listServers(selectedEnvironment.id).then(({ servers }) => {
        const allServices: Service[] = [];
        for (const server of servers || []) {
          for (const service of (server as { services?: Service[] }).services || []) {
            allServices.push({ ...service, server } as Service);
          }
        }
        setServices(allServices);
      });
      listServiceTypes().then(({ serviceTypes }) => setServiceTypes(serviceTypes));
    }
  }, [selectedEnvironment?.id]);

  useEffect(() => {
    if (!isNew && id && selectedEnvironment?.id) {
      setLoading(true);
      getDeploymentTemplate(selectedEnvironment.id, id)
        .then(({ template }) => {
          setTemplate(template);
          setName(template.name);
          setDescription(template.description || '');
          try {
            const def = JSON.parse(template.definition) as TemplateDefinition;
            setParallelExecution(def.parallelExecution);
            setSteps(addStepIds(def.steps));
          } catch {
            toast.error('Failed to parse template definition');
          }
        })
        .catch((err) => {
          toast.error(err.message);
          navigate('/deployment-templates');
        })
        .finally(() => setLoading(false));
    }
  }, [id, isNew, selectedEnvironment?.id, navigate, toast]);

  // Sync YAML when switching to YAML tab
  useEffect(() => {
    if (activeTab === 'yaml') {
      const def: TemplateDefinition = {
        version: '1.0',
        parallelExecution,
        steps: stripStepIds(steps),
      };
      // Simple YAML-like formatting (without library)
      setYamlContent(definitionToYamlLike(def));
    }
  }, [activeTab, parallelExecution, steps]);

  const addStepIds = (steps: TemplateStep[]): EditableStep[] => {
    return steps.map((step, i) => ({
      ...step,
      id: `step-${Date.now()}-${i}`,
      children: step.children ? addStepIds(step.children) : undefined,
    }));
  };

  const stripStepIds = (steps: EditableStep[]): TemplateStep[] => {
    return steps.map(({ id, ...step }) => ({
      ...step,
      children: step.children ? stripStepIds(step.children as EditableStep[]) : undefined,
    }));
  };

  const buildDefinition = (): TemplateDefinition => ({
    version: '1.0',
    parallelExecution,
    steps: stripStepIds(steps),
  });

  const handleSave = async () => {
    if (!selectedEnvironment?.id || !name.trim()) {
      toast.error('Name is required');
      return;
    }

    setSaving(true);
    try {
      const definition = JSON.stringify(buildDefinition());

      if (isNew) {
        const { template } = await createDeploymentTemplate(selectedEnvironment.id, {
          name: name.trim(),
          description: description.trim() || undefined,
          definition,
        });
        toast.success('Template created');
        navigate(`/deployment-templates/${template.id}`);
      } else if (id) {
        await updateDeploymentTemplate(selectedEnvironment.id, id, {
          name: name.trim(),
          description: description.trim() || undefined,
          definition,
        });
        toast.success('Template saved');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    if (!selectedEnvironment?.id || !id || isNew) {
      toast.error('Save the template first to preview');
      return;
    }

    setLoadingPreview(true);
    try {
      const { preview } = await previewDeploymentTemplate(selectedEnvironment.id, id, previewTag);
      setPreview(preview);
      setShowPreview(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Preview failed');
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleExecute = async () => {
    if (!selectedEnvironment?.id || !id) return;

    setExecuting(true);
    try {
      const { planId } = await executeDeploymentTemplate(selectedEnvironment.id, id, executeTag);
      toast.success('Deployment started');
      navigate(`/deployment-plans/${planId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Execution failed');
    } finally {
      setExecuting(false);
    }
  };

  const addStep = (type: TemplateStep['type']) => {
    const newStep: EditableStep = {
      id: `step-${Date.now()}`,
      type,
    };

    if (type === 'deploy') {
      newStep.serviceSelector = { by: 'name', value: '' };
    } else if (type === 'health_check') {
      newStep.serviceSelector = { by: 'name', value: '' };
      newStep.waitMs = 30000;
      newStep.retries = 3;
    } else if (type === 'wait') {
      newStep.durationMs = 5000;
    } else if (type === 'group') {
      newStep.name = 'Group';
      newStep.parallel = true;
      newStep.children = [];
    }

    setSteps([...steps, newStep]);
  };

  const updateStep = (index: number, updates: Partial<EditableStep>) => {
    setSteps(steps.map((s, i) => (i === index ? { ...s, ...updates } : s)));
  };

  const removeStep = (index: number) => {
    setSteps(steps.filter((_, i) => i !== index));
  };

  const moveStep = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= steps.length) return;

    const newSteps = [...steps];
    [newSteps[index], newSteps[newIndex]] = [newSteps[newIndex], newSteps[index]];
    setSteps(newSteps);
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-slate-400">Select an environment to edit templates</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-7 w-48 bg-slate-700 rounded mb-5"></div>
          <div className="h-64 bg-slate-800 rounded-lg"></div>
        </div>
      </div>
    );
  }

  // Execute mode - show execution form
  if (isExecuteMode && template) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <Link to="/deployment-templates" className="text-slate-400 hover:text-white">
            Templates
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-white">{template.name}</span>
          <span className="text-slate-600">/</span>
          <span className="text-slate-400">Execute</span>
        </div>

        <div className="panel max-w-lg">
          <h2 className="text-xl font-semibold text-white mb-4">Execute Template</h2>
          <p className="text-slate-400 text-sm mb-6">
            Deploy services using the "{template.name}" template
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Target Tag</label>
              <input
                type="text"
                value={executeTag}
                onChange={(e) => setExecuteTag(e.target.value)}
                placeholder="latest"
                className="input font-mono"
              />
              <p className="text-xs text-slate-500 mt-1">
                Image tag to deploy for all services in this template
              </p>
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-slate-700">
              <button
                onClick={handlePreview}
                disabled={loadingPreview}
                className="btn btn-ghost"
              >
                {loadingPreview ? 'Loading...' : 'Preview'}
              </button>
              <div className="flex gap-2">
                <Link to="/deployment-templates" className="btn btn-ghost">
                  Cancel
                </Link>
                <button
                  onClick={handleExecute}
                  disabled={executing || !executeTag}
                  className="btn btn-primary"
                >
                  {executing ? 'Starting...' : 'Execute'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Preview Modal */}
        {showPreview && preview && (
          <DeploymentPreview
            preview={preview}
            templateName={template.name}
            onClose={() => setShowPreview(false)}
            onExecute={() => {
              setShowPreview(false);
              handleExecute();
            }}
            executing={executing}
          />
        )}
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <Link to="/deployment-templates" className="text-slate-400 hover:text-white">
            Templates
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-white">{isNew ? 'New Template' : name}</span>
        </div>
        <div className="flex gap-2">
          {!isNew && (
            <button
              onClick={handlePreview}
              disabled={loadingPreview || steps.length === 0}
              className="btn btn-ghost"
            >
              {loadingPreview ? 'Loading...' : 'Preview'}
            </button>
          )}
          <Link to="/deployment-templates" className="btn btn-ghost">
            Cancel
          </Link>
          <button onClick={handleSave} disabled={saving} className="btn btn-primary">
            {saving ? 'Saving...' : isNew ? 'Create' : 'Save'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Main Editor */}
        <div className="col-span-2 space-y-6">
          {/* Basic Info */}
          <div className="panel">
            <h3 className="text-lg font-semibold text-white mb-4">Template Info</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Full Stack Deploy"
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Deploy all services in dependency order..."
                  rows={2}
                  className="input"
                />
              </div>
              <div className="flex items-center justify-between pt-4 border-t border-slate-700">
                <div>
                  <p className="text-white font-medium">Parallel Execution</p>
                  <p className="text-sm text-slate-400">
                    Run same-level steps concurrently for faster deployments
                  </p>
                </div>
                <button
                  onClick={() => setParallelExecution(!parallelExecution)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    parallelExecution ? 'bg-primary-600' : 'bg-slate-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      parallelExecution ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Steps Editor */}
          <div className="panel">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Steps</h3>
              <div className="flex border border-slate-700 rounded-lg overflow-hidden">
                <button
                  onClick={() => setActiveTab('visual')}
                  className={`px-3 py-1.5 text-sm ${
                    activeTab === 'visual'
                      ? 'bg-slate-700 text-white'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  Visual
                </button>
                <button
                  onClick={() => setActiveTab('yaml')}
                  className={`px-3 py-1.5 text-sm ${
                    activeTab === 'yaml'
                      ? 'bg-slate-700 text-white'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  YAML
                </button>
              </div>
            </div>

            {activeTab === 'visual' ? (
              <div className="space-y-3">
                {steps.length === 0 ? (
                  <div className="text-center py-8 border-2 border-dashed border-slate-700 rounded-lg">
                    <p className="text-slate-500 mb-3">No steps added yet</p>
                    <div className="flex gap-2 justify-center">
                      <button onClick={() => addStep('deploy')} className="btn btn-sm btn-primary">
                        Add Deploy
                      </button>
                      <button onClick={() => addStep('health_check')} className="btn btn-sm btn-ghost">
                        Add Health Check
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {steps.map((step, index) => (
                      <StepEditor
                        key={step.id}
                        step={step}
                        index={index}
                        totalSteps={steps.length}
                        services={services}
                        serviceTypes={serviceTypes}
                        onUpdate={(updates) => updateStep(index, updates)}
                        onRemove={() => removeStep(index)}
                        onMove={(direction) => moveStep(index, direction)}
                      />
                    ))}
                    <div className="flex gap-2 pt-3 border-t border-slate-700">
                      <button onClick={() => addStep('deploy')} className="btn btn-sm btn-ghost">
                        + Deploy
                      </button>
                      <button onClick={() => addStep('health_check')} className="btn btn-sm btn-ghost">
                        + Health Check
                      </button>
                      <button onClick={() => addStep('wait')} className="btn btn-sm btn-ghost">
                        + Wait
                      </button>
                      <button onClick={() => addStep('group')} className="btn btn-sm btn-ghost">
                        + Group
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <textarea
                  value={yamlContent}
                  onChange={(e) => setYamlContent(e.target.value)}
                  rows={20}
                  className="input font-mono text-sm"
                  placeholder="version: '1.0'..."
                />
                {yamlError && (
                  <p className="text-red-400 text-sm">{yamlError}</p>
                )}
                <p className="text-xs text-slate-500">
                  Note: YAML editing is read-only in this preview. Use the Export/Import feature for full YAML support.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Quick Reference */}
          <div className="panel">
            <h3 className="text-lg font-semibold text-white mb-4">Step Types</h3>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-white font-medium">Deploy</p>
                <p className="text-slate-400">Deploy services matching a selector</p>
              </div>
              <div>
                <p className="text-white font-medium">Health Check</p>
                <p className="text-slate-400">Wait for services to become healthy</p>
              </div>
              <div>
                <p className="text-white font-medium">Wait</p>
                <p className="text-slate-400">Pause execution for a duration</p>
              </div>
              <div>
                <p className="text-white font-medium">Group</p>
                <p className="text-slate-400">Group steps to run in parallel</p>
              </div>
            </div>
          </div>

          {/* Selector Reference */}
          <div className="panel">
            <h3 className="text-lg font-semibold text-white mb-4">Selectors</h3>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-white font-medium">By Name</p>
                <p className="text-slate-400">Match service name (supports * wildcard)</p>
              </div>
              <div>
                <p className="text-white font-medium">By Service Type</p>
                <p className="text-slate-400">Match all services of a type (Django, Node.js, etc.)</p>
              </div>
              <div>
                <p className="text-white font-medium">By Tag</p>
                <p className="text-slate-400">Match services on servers with a tag</p>
              </div>
              <div>
                <p className="text-white font-medium">By ID</p>
                <p className="text-slate-400">Match a specific service</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Preview Modal */}
      {showPreview && preview && (
        <DeploymentPreview
          preview={preview}
          templateName={name}
          onClose={() => setShowPreview(false)}
          onExecute={isNew ? undefined : handleExecute}
          executing={executing}
        />
      )}
    </div>
  );
}

interface StepEditorProps {
  step: EditableStep;
  index: number;
  totalSteps: number;
  services: Service[];
  serviceTypes: ServiceType[];
  onUpdate: (updates: Partial<EditableStep>) => void;
  onRemove: () => void;
  onMove: (direction: 'up' | 'down') => void;
}

function StepEditor({
  step,
  index,
  totalSteps,
  services,
  serviceTypes,
  onUpdate,
  onRemove,
  onMove,
}: StepEditorProps) {
  const typeColors = {
    deploy: 'border-blue-500/30 bg-blue-500/5',
    health_check: 'border-green-500/30 bg-green-500/5',
    wait: 'border-yellow-500/30 bg-yellow-500/5',
    group: 'border-purple-500/30 bg-purple-500/5',
  };

  return (
    <div className={`border rounded-lg p-4 ${typeColors[step.type]}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">#{index + 1}</span>
          <span className="badge bg-slate-700 text-white text-xs capitalize">
            {step.type.replace('_', ' ')}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onMove('up')}
            disabled={index === 0}
            className="p-1 text-slate-400 hover:text-white disabled:opacity-50"
            title="Move up"
          >
            <ChevronUpIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => onMove('down')}
            disabled={index === totalSteps - 1}
            className="p-1 text-slate-400 hover:text-white disabled:opacity-50"
            title="Move down"
          >
            <ChevronDownIcon className="w-4 h-4" />
          </button>
          <button
            onClick={onRemove}
            className="p-1 text-red-400 hover:text-red-300"
            title="Remove"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {(step.type === 'deploy' || step.type === 'health_check') && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Select By</label>
              <select
                value={step.serviceSelector?.by || 'name'}
                onChange={(e) =>
                  onUpdate({
                    serviceSelector: {
                      ...step.serviceSelector,
                      by: e.target.value as 'id' | 'name' | 'tag' | 'serviceType',
                      value: '',
                    },
                  })
                }
                className="input text-sm"
              >
                <option value="name">Name</option>
                <option value="serviceType">Service Type</option>
                <option value="tag">Server Tag</option>
                <option value="id">Service ID</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1">Value</label>
              {step.serviceSelector?.by === 'serviceType' ? (
                <select
                  value={step.serviceSelector?.value || ''}
                  onChange={(e) =>
                    onUpdate({
                      serviceSelector: { ...step.serviceSelector, by: 'serviceType', value: e.target.value },
                    })
                  }
                  className="input text-sm"
                >
                  <option value="">Select type...</option>
                  {serviceTypes.map((t) => (
                    <option key={t.id} value={t.name}>
                      {t.displayName}
                    </option>
                  ))}
                </select>
              ) : step.serviceSelector?.by === 'id' ? (
                <select
                  value={step.serviceSelector?.value || ''}
                  onChange={(e) =>
                    onUpdate({
                      serviceSelector: { ...step.serviceSelector, by: 'id', value: e.target.value },
                    })
                  }
                  className="input text-sm"
                >
                  <option value="">Select service...</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={step.serviceSelector?.value || ''}
                  onChange={(e) =>
                    onUpdate({
                      serviceSelector: { ...step.serviceSelector, by: step.serviceSelector?.by || 'name', value: e.target.value },
                    })
                  }
                  placeholder={step.serviceSelector?.by === 'name' ? 'api-*' : 'gateway'}
                  className="input text-sm"
                />
              )}
            </div>
          </div>
          {step.serviceSelector?.by === 'name' && (
            <label className="flex items-center gap-2 text-sm text-slate-400">
              <input
                type="checkbox"
                checked={step.serviceSelector?.pattern || false}
                onChange={(e) =>
                  onUpdate({
                    serviceSelector: { ...step.serviceSelector, by: 'name', value: step.serviceSelector?.value || '', pattern: e.target.checked },
                  })
                }
                className="rounded bg-slate-700 border-slate-600"
              />
              Use as pattern (supports * wildcard)
            </label>
          )}
        </div>
      )}

      {step.type === 'health_check' && (
        <div className="grid grid-cols-2 gap-2 mt-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Wait (ms)</label>
            <input
              type="number"
              value={step.waitMs || 30000}
              onChange={(e) => onUpdate({ waitMs: parseInt(e.target.value) || 30000 })}
              className="input text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Retries</label>
            <input
              type="number"
              value={step.retries || 3}
              onChange={(e) => onUpdate({ retries: parseInt(e.target.value) || 3 })}
              className="input text-sm"
            />
          </div>
        </div>
      )}

      {step.type === 'wait' && (
        <div>
          <label className="block text-xs text-slate-500 mb-1">Duration (ms)</label>
          <input
            type="number"
            value={step.durationMs || 5000}
            onChange={(e) => onUpdate({ durationMs: parseInt(e.target.value) || 5000 })}
            className="input text-sm"
          />
        </div>
      )}

      {step.type === 'group' && (
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Group Name</label>
            <input
              type="text"
              value={step.name || ''}
              onChange={(e) => onUpdate({ name: e.target.value })}
              placeholder="API Layer"
              className="input text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={step.parallel || false}
              onChange={(e) => onUpdate({ parallel: e.target.checked })}
              className="rounded bg-slate-700 border-slate-600"
            />
            Run group steps in parallel
          </label>
          <p className="text-xs text-slate-500">
            Group children editing is available in YAML mode
          </p>
        </div>
      )}
    </div>
  );
}

function definitionToYamlLike(def: TemplateDefinition): string {
  let yaml = `version: "${def.version}"\n`;
  yaml += `parallelExecution: ${def.parallelExecution}\n`;
  yaml += `steps:\n`;

  for (const step of def.steps) {
    yaml += stepToYaml(step, 2);
  }

  return yaml;
}

function stepToYaml(step: TemplateStep, indent: number): string {
  const pad = ' '.repeat(indent);
  let yaml = `${pad}- type: ${step.type}\n`;

  if (step.serviceSelector) {
    yaml += `${pad}  serviceSelector:\n`;
    yaml += `${pad}    by: ${step.serviceSelector.by}\n`;
    yaml += `${pad}    value: "${step.serviceSelector.value}"\n`;
    if (step.serviceSelector.pattern) {
      yaml += `${pad}    pattern: true\n`;
    }
  }

  if (step.waitMs) yaml += `${pad}  waitMs: ${step.waitMs}\n`;
  if (step.retries) yaml += `${pad}  retries: ${step.retries}\n`;
  if (step.durationMs) yaml += `${pad}  durationMs: ${step.durationMs}\n`;
  if (step.name) yaml += `${pad}  name: "${step.name}"\n`;
  if (step.parallel !== undefined) yaml += `${pad}  parallel: ${step.parallel}\n`;

  if (step.children && step.children.length > 0) {
    yaml += `${pad}  children:\n`;
    for (const child of step.children) {
      yaml += stepToYaml(child, indent + 4);
    }
  }

  return yaml;
}

function ChevronUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
