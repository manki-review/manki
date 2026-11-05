import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

import { loadConfigFromContent } from './config';

interface ActionInput {
  required?: boolean;
  default?: string;
}

interface MankiStep {
  uses: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Record<string, unknown>>;
}

const ROOT = path.join(__dirname, '..');

function readRepoFile(name: string): string {
  return fs.readFileSync(path.join(ROOT, name), 'utf-8');
}

function markdownYamlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map(m => m[1]);
}

function htmlCodeBlocks(html: string): string[] {
  return [...html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map(m => m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&'));
}

function isDispatchWorkflow(workflow: Partial<Workflow>): boolean {
  return !!workflow.on && 'workflow_dispatch' in workflow.on;
}

function findMankiSteps(node: unknown): MankiStep[] {
  if (Array.isArray(node)) return node.flatMap(findMankiSteps);
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  if (typeof obj.uses === 'string' && obj.uses.startsWith('manki-review/manki@')) return [obj as unknown as MankiStep];
  return Object.values(obj).flatMap(findMankiSteps);
}

describe('documented workflow snippets', () => {
  const inputs = (parseYaml(readRepoFile('action.yml')) as { inputs: Record<string, ActionInput> }).inputs;
  const requiredInputs = Object.entries(inputs)
    .filter(([, input]) => input.required === true && input.default === undefined)
    .map(([name]) => name);
  const setup = readRepoFile('SETUP.md');
  const usesManki = (block: string) => block.includes('manki-review/manki@');
  const snippets = {
    'SETUP.md': markdownYamlBlocks(setup).filter(usesManki),
    'docs/index.html': htmlCodeBlocks(readRepoFile('docs/index.html')).filter(usesManki),
  };

  it('includes the full workflow from SETUP.md Step 3 and docs/index.html, with the job settings of our own workflow', () => {
    const own = (parseYaml(readRepoFile('.github/workflows/manki.yml')) as Workflow).jobs.review;
    const step3 = setup.slice(setup.indexOf('## Step 3: Add the Workflow'));
    for (const block of [markdownYamlBlocks(step3)[0], snippets['docs/index.html'][0]]) {
      const workflow = parseYaml(block) as Workflow;
      expect(Object.keys(workflow.on)).toContain('pull_request');
      expect(findMankiSteps(workflow)).toHaveLength(1);
      const { if: condition, concurrency, 'timeout-minutes': timeout } = workflow.jobs.review;
      expect({ condition, concurrency, timeout }).toEqual({ condition: own.if, concurrency: own.concurrency, timeout: own['timeout-minutes'] });
    }
    const jobs = Object.values(snippets).flat().map(block => parseYaml(block) as Partial<Workflow>)
      .filter(workflow => !isDispatchWorkflow(workflow)).map(workflow => workflow.jobs?.review).filter(job => job !== undefined);
    expect(jobs.length).toBeGreaterThan(2);
    for (const job of jobs) expect(job.if).toContain(own.if);
    expect(snippets['SETUP.md'].length).toBeGreaterThan(1);
  });

  it('includes a dispatch workflow in SETUP.md that declares the dispatch inputs, with no `if` or `concurrency`, as our own does', () => {
    const dispatch = snippets['SETUP.md'].map(block => parseYaml(block) as Workflow).filter(isDispatchWorkflow);
    expect(dispatch).toHaveLength(1);
    const own = parseYaml(readRepoFile('.github/workflows/manki-dispatch.yml')) as Workflow;
    for (const workflow of [dispatch[0], own]) {
      expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
      expect(workflow.on.workflow_dispatch).toEqual(dispatch[0].on.workflow_dispatch);
      expect((workflow as Workflow & { 'run-name': string })['run-name']).toBe('Manki ${{ inputs.event }}.${{ inputs.action }} on #${{ inputs.pr }} (${{ inputs.delivery_id }})');
      const { if: condition, concurrency, 'timeout-minutes': timeout } = workflow.jobs.review;
      expect({ condition, concurrency, timeout }).toEqual({ condition: undefined, concurrency: undefined, timeout: 30 });
    }
    const { inputs: dispatchInputs } = dispatch[0].on.workflow_dispatch as { inputs: Record<string, unknown> };
    expect(Object.keys(dispatchInputs)).toEqual(['event', 'action', 'pr', 'head_sha', 'comment_id', 'review_id', 'delivery_id']);
  });

  it('passes only inputs that `action.yml` accepts and every required input', () => {
    const problems = Object.entries(snippets).flatMap(([file, blocks]) => blocks.flatMap((block, index) =>
      findMankiSteps(parseYaml(block)).flatMap(step => {
        const passed = Object.keys(step.with ?? {});
        return [
          ...passed.filter(name => !(name in inputs)).map(name => `${file} snippet ${index}: unknown input \`${name}\``),
          ...requiredInputs.filter(name => !passed.includes(name)).map(name => `${file} snippet ${index}: missing required input \`${name}\``),
        ];
      })));
    expect(problems).toEqual([]);
  });
});

describe('documented `review` examples', () => {
  it('load as valid config, in SETUP.md and uncommented from `.manki.yml.example`', () => {
    const setupBlocks = markdownYamlBlocks(readRepoFile('SETUP.md')).filter(block => /^review:/m.test(block));
    const example = readRepoFile('.manki.yml.example');
    const exampleBlocks = [...example.matchAll(/^# review:\n(?:#[ ]{2,}.*\n)+/gm)].map(m => m[0].replace(/^# ?/gm, ''));
    expect([setupBlocks.length, exampleBlocks.length]).toEqual([2, 2]);
    for (const block of [...setupBlocks, ...exampleBlocks]) {
      expect(loadConfigFromContent(block).review?.groups?.deep).toBeDefined();
    }
  });
});
