import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

interface ActionInput {
  required?: boolean;
  default?: string;
}

interface MankiStep {
  uses: string;
  with?: Record<string, unknown>;
}

const ROOT = path.join(__dirname, '..');

function readRepoFile(name: string): string {
  return fs.readFileSync(path.join(ROOT, name), 'utf-8');
}

function yamlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map(m => m[1]);
}

function findMankiSteps(node: unknown): MankiStep[] {
  if (Array.isArray(node)) return node.flatMap(findMankiSteps);
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  if (typeof obj.uses === 'string' && obj.uses.startsWith('manki-review/manki@')) return [obj as unknown as MankiStep];
  return Object.values(obj).flatMap(findMankiSteps);
}

describe('SETUP.md workflow snippets', () => {
  const inputs = (parseYaml(readRepoFile('action.yml')) as { inputs: Record<string, ActionInput> }).inputs;
  const requiredInputs = Object.entries(inputs)
    .filter(([, input]) => input.required === true && input.default === undefined)
    .map(([name]) => name);
  const setup = readRepoFile('SETUP.md');
  const snippets = yamlBlocks(setup).filter(block => block.includes('manki-review/manki@'));

  it('includes the Step 3 workflow', () => {
    const step3 = setup.slice(setup.indexOf('## Step 3: Add the Workflow'));
    const workflow = parseYaml(yamlBlocks(step3)[0]) as { on: Record<string, unknown> };
    expect(Object.keys(workflow.on)).toContain('pull_request');
    expect(findMankiSteps(workflow)).toHaveLength(1);
    expect(snippets.length).toBeGreaterThan(1);
  });

  it('passes only inputs that `action.yml` accepts and every required input', () => {
    const problems = snippets.flatMap((snippet, index) => findMankiSteps(parseYaml(snippet)).flatMap(step => {
      const passed = Object.keys(step.with ?? {});
      return [
        ...passed.filter(name => !(name in inputs)).map(name => `snippet ${index}: unknown input \`${name}\``),
        ...requiredInputs.filter(name => !passed.includes(name)).map(name => `snippet ${index}: missing required input \`${name}\``),
      ];
    }));
    expect(problems).toEqual([]);
  });
});
