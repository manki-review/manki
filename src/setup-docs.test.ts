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
  'run-name': string;
  on: Record<string, unknown>;
  jobs: Record<string, Record<string, unknown>>;
}

const ROOT = path.join(__dirname, '..');

function readRepoFile(name: string): string {
  return fs.readFileSync(path.join(ROOT, name), 'utf-8');
}

function withoutFencedBlocks(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```$/gm, '');
}

function withoutCodeBlocks(markdown: string): string {
  return withoutFencedBlocks(markdown).replace(/`[^`\n]*`/g, '');
}

/** Returns the anchors GitHub gives the headings of `markdown`. */
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const [, heading] of withoutFencedBlocks(markdown).replace(/`/g, '').matchAll(/^#{1,6} (.+)$/gm)) {
    const slug = heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
    let anchor = slug;
    for (let n = 1; anchors.has(anchor); n++) anchor = `${slug}-${n}`;
    anchors.add(anchor);
  }
  return anchors;
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
  const setup = readRepoFile('docs/getting-started.md');
  const usesManki = (block: string) => block.includes('manki-review/manki@');
  const snippets = {
    'docs/getting-started.md': markdownYamlBlocks(setup).filter(usesManki),
    'docs/how-reviews-work.md': markdownYamlBlocks(readRepoFile('docs/how-reviews-work.md')).filter(usesManki),
    'docs/index.html': htmlCodeBlocks(readRepoFile('docs/index.html')).filter(usesManki),
  };

  it('includes the workflow from Step 3 of `docs/getting-started.md` and docs/index.html, with the triggers and job settings of our own', () => {
    const own = parseYaml(readRepoFile('.github/workflows/manki.yml')) as Workflow;
    const step3 = setup.slice(setup.indexOf('## Step 3: Add the Workflow'));
    const documented = [markdownYamlBlocks(step3)[0], snippets['docs/index.html'][0]].map(block => parseYaml(block) as Workflow);
    for (const workflow of [...documented, own]) {
      expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
      expect(workflow.on.workflow_dispatch).toEqual(own.on.workflow_dispatch);
      expect(workflow['run-name']).toBe(own['run-name']);
      const { if: condition, concurrency, 'timeout-minutes': timeout } = workflow.jobs.review;
      expect({ condition, concurrency, timeout }).toEqual({ condition: undefined, concurrency: undefined, timeout: 30 });
    }
    for (const workflow of documented) expect(findMankiSteps(workflow)).toHaveLength(1);
    const { inputs: dispatchInputs } = own.on.workflow_dispatch as { inputs: Record<string, unknown> };
    expect(Object.keys(dispatchInputs)).toEqual(['event', 'action', 'pr', 'head_sha', 'comment_id', 'review_id', 'delivery_id']);
    expect(snippets['docs/getting-started.md'].filter(block => (parseYaml(block) as Partial<Workflow>).on)).toHaveLength(1);
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
  it('load as valid config, in `docs/how-reviews-work.md` and uncommented from `.manki.yml.example`', () => {
    const setupBlocks = markdownYamlBlocks(readRepoFile('docs/how-reviews-work.md')).filter(block => /^review:/m.test(block));
    const example = readRepoFile('.manki.yml.example');
    const exampleBlocks = [...example.matchAll(/^# review:\n(?:#[ ]{2,}.*\n)+/gm)].map(m => m[0].replace(/^# ?/gm, ''));
    expect([setupBlocks.length, exampleBlocks.length]).toEqual([3, 2]);
    const reviews = [...setupBlocks, ...exampleBlocks].map(block => loadConfigFromContent(block).review);
    expect(reviews.filter(review => review?.groups?.deep)).toHaveLength(4);
    expect(reviews.filter(review => review?.outside_input && review.examples && Object.values(review.classes ?? {}).some(c => c.critical))).toHaveLength(2);
  });
});

describe('documentation links', () => {
  it('point to files and headings that exist, in the README and every page under `docs/`', () => {
    const pages = ['README.md', 'SETUP.md', ...fs.readdirSync(path.join(ROOT, 'docs')).filter(f => f.endsWith('.md')).map(f => `docs/${f}`)];
    expect(pages).toEqual(expect.arrayContaining(['docs/getting-started.md', 'docs/how-reviews-work.md', 'docs/configuration.md', 'docs/memory.md', 'docs/security.md']));
    const broken = pages.flatMap(page => [...withoutCodeBlocks(readRepoFile(page)).matchAll(/\]\(([^)\s]+)\)/g)].flatMap(([, target]) => {
      if (/^[a-z]+:/i.test(target)) return [];
      const [file, anchor] = target.split('#');
      const resolved = file ? path.join(path.dirname(page), file) : page;
      if (!fs.existsSync(path.join(ROOT, resolved))) return [`${page}: ${target} (no file)`];
      if (anchor === undefined || !resolved.endsWith('.md')) return [];
      return headingAnchors(readRepoFile(resolved)).has(anchor) ? [] : [`${page}: ${target} (no heading)`];
    }));
    expect(broken).toEqual([]);
  });
});
