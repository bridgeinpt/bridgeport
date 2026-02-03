import type { TemplateDefinition, TemplateStep } from './template-execution.js';

/**
 * Parse YAML template to TemplateDefinition
 * Uses a simple YAML parser since we have a well-defined schema
 */
export function parseTemplateYaml(yaml: string): TemplateDefinition {
  // Simple YAML parsing for our specific schema
  const lines = yaml.split('\n');
  const result: Partial<TemplateDefinition> = {
    version: '1.0',
    parallelExecution: false,
    steps: [],
  };

  let currentIndent = 0;
  let inSettings = false;
  let inSteps = false;
  let currentStep: Partial<TemplateStep> | null = null;
  let currentGroup: Partial<TemplateStep> | null = null;
  let currentServiceSelector: TemplateStep['serviceSelector'] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Top-level keys
    if (indent === 0) {
      if (trimmed.startsWith('version:')) {
        const version = trimmed.split(':')[1].trim().replace(/['"]/g, '');
        if (version !== '1.0') {
          throw new Error(`Unsupported template version: ${version}`);
        }
        result.version = '1.0';
      } else if (trimmed === 'settings:') {
        inSettings = true;
        inSteps = false;
      } else if (trimmed === 'steps:') {
        inSettings = false;
        inSteps = true;
      }
      continue;
    }

    // Settings section
    if (inSettings && indent === 2) {
      if (trimmed.startsWith('parallelExecution:')) {
        result.parallelExecution = trimmed.includes('true');
      }
      continue;
    }

    // Steps section
    if (inSteps) {
      // New step at top level
      if (indent === 2 && trimmed.startsWith('- type:')) {
        // Save previous step
        if (currentStep) {
          if (currentGroup) {
            currentGroup.children = currentGroup.children || [];
            currentGroup.children.push(currentStep as TemplateStep);
          } else {
            result.steps!.push(currentStep as TemplateStep);
          }
        }

        const type = trimmed.split(':')[1].trim() as TemplateStep['type'];
        currentStep = { type };
        currentGroup = null;
        currentServiceSelector = null;
        continue;
      }

      // Step properties
      if (currentStep && indent >= 4) {
        if (trimmed.startsWith('name:')) {
          currentStep.name = trimmed.split(':').slice(1).join(':').trim().replace(/['"]/g, '');
        } else if (trimmed.startsWith('parallel:')) {
          currentStep.parallel = trimmed.includes('true');
        } else if (trimmed.startsWith('waitMs:')) {
          currentStep.waitMs = parseInt(trimmed.split(':')[1].trim());
        } else if (trimmed.startsWith('durationMs:')) {
          currentStep.durationMs = parseInt(trimmed.split(':')[1].trim());
        } else if (trimmed.startsWith('retries:')) {
          currentStep.retries = parseInt(trimmed.split(':')[1].trim());
        } else if (trimmed.startsWith('service:')) {
          // Start of service selector - could be inline or block
          const inlineMatch = trimmed.match(/service:\s*\{\s*by:\s*(\w+),\s*value:\s*["']?([^"'}]+)["']?/);
          if (inlineMatch) {
            currentStep.serviceSelector = {
              by: inlineMatch[1] as 'id' | 'name' | 'tag' | 'serviceType',
              value: inlineMatch[2],
              pattern: trimmed.includes('pattern: true'),
            };
          } else {
            currentServiceSelector = { by: 'name', value: '' };
          }
        } else if (currentServiceSelector) {
          if (trimmed.startsWith('by:')) {
            currentServiceSelector.by = trimmed.split(':')[1].trim() as 'id' | 'name' | 'tag' | 'serviceType';
          } else if (trimmed.startsWith('value:')) {
            currentServiceSelector.value = trimmed.split(':').slice(1).join(':').trim().replace(/['"]/g, '');
          } else if (trimmed.startsWith('pattern:')) {
            currentServiceSelector.pattern = trimmed.includes('true');
          }
          currentStep.serviceSelector = currentServiceSelector;
        } else if (trimmed === 'steps:') {
          // This is a group with children
          currentGroup = currentStep;
          currentGroup.children = [];
          currentStep = null;
        }
      }

      // Child steps in a group
      if (currentGroup && indent === 6 && trimmed.startsWith('- type:')) {
        if (currentStep) {
          currentGroup.children!.push(currentStep as TemplateStep);
        }
        const type = trimmed.split(':')[1].trim() as TemplateStep['type'];
        currentStep = { type };
        currentServiceSelector = null;
      }
    }
  }

  // Save last step
  if (currentStep) {
    if (currentGroup) {
      currentGroup.children = currentGroup.children || [];
      currentGroup.children.push(currentStep as TemplateStep);
      result.steps!.push(currentGroup as TemplateStep);
    } else {
      result.steps!.push(currentStep as TemplateStep);
    }
  } else if (currentGroup) {
    result.steps!.push(currentGroup as TemplateStep);
  }

  return result as TemplateDefinition;
}

/**
 * Serialize TemplateDefinition to YAML
 */
export function serializeTemplateYaml(definition: TemplateDefinition): string {
  const lines: string[] = [];

  lines.push(`version: "${definition.version}"`);
  lines.push('');
  lines.push('settings:');
  lines.push(`  parallelExecution: ${definition.parallelExecution}`);
  lines.push('');
  lines.push('steps:');

  for (const step of definition.steps) {
    serializeStep(step, lines, 2);
  }

  return lines.join('\n');
}

function serializeStep(step: TemplateStep, lines: string[], indent: number): void {
  const pad = ' '.repeat(indent);

  lines.push(`${pad}- type: ${step.type}`);

  if (step.name) {
    lines.push(`${pad}  name: "${step.name}"`);
  }

  if (step.type === 'deploy' || step.type === 'health_check') {
    if (step.serviceSelector) {
      const sel = step.serviceSelector;
      if (sel.pattern) {
        lines.push(`${pad}  service: { by: ${sel.by}, value: "${sel.value}", pattern: true }`);
      } else {
        lines.push(`${pad}  service: { by: ${sel.by}, value: "${sel.value}" }`);
      }
    }
  }

  if (step.type === 'health_check') {
    if (step.waitMs !== undefined) {
      lines.push(`${pad}  waitMs: ${step.waitMs}`);
    }
    if (step.retries !== undefined) {
      lines.push(`${pad}  retries: ${step.retries}`);
    }
  }

  if (step.type === 'wait' && step.durationMs !== undefined) {
    lines.push(`${pad}  durationMs: ${step.durationMs}`);
  }

  if (step.type === 'group') {
    if (step.parallel !== undefined) {
      lines.push(`${pad}  parallel: ${step.parallel}`);
    }
    if (step.children && step.children.length > 0) {
      lines.push(`${pad}  steps:`);
      for (const child of step.children) {
        serializeStep(child, lines, indent + 4);
      }
    }
  }
}

/**
 * Validate a template definition
 */
export function validateTemplateDefinition(definition: TemplateDefinition): string[] {
  const errors: string[] = [];

  if (definition.version !== '1.0') {
    errors.push(`Unsupported version: ${definition.version}`);
  }

  if (!Array.isArray(definition.steps)) {
    errors.push('Template must have a steps array');
    return errors;
  }

  for (let i = 0; i < definition.steps.length; i++) {
    const step = definition.steps[i];
    validateStep(step, `steps[${i}]`, errors);
  }

  return errors;
}

function validateStep(step: TemplateStep, path: string, errors: string[]): void {
  const validTypes = ['deploy', 'health_check', 'wait', 'group'];
  if (!validTypes.includes(step.type)) {
    errors.push(`${path}: Invalid step type "${step.type}"`);
  }

  if ((step.type === 'deploy' || step.type === 'health_check') && !step.serviceSelector) {
    errors.push(`${path}: ${step.type} step must have a serviceSelector`);
  }

  if (step.serviceSelector) {
    const validBy = ['id', 'name', 'tag', 'serviceType'];
    if (!validBy.includes(step.serviceSelector.by)) {
      errors.push(`${path}.serviceSelector.by: Invalid value "${step.serviceSelector.by}"`);
    }
    if (!step.serviceSelector.value) {
      errors.push(`${path}.serviceSelector.value: Required`);
    }
  }

  if (step.type === 'wait' && !step.durationMs) {
    errors.push(`${path}: wait step must have durationMs`);
  }

  if (step.type === 'group' && step.children) {
    for (let i = 0; i < step.children.length; i++) {
      validateStep(step.children[i], `${path}.children[${i}]`, errors);
    }
  }
}
