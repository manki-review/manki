import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import * as core from '@actions/core';
import type { NapiConfig, parse, registerDynamicLanguage } from '@ast-grep/napi';
import { parseAllDocuments } from 'yaml';

import { installTarball, PinnedDownload } from './tool-install';
import { StaticSignal } from './types';

/** The part of `@ast-grep/napi` the analyzer uses, with the Python grammar registered as `python`. */
export interface AstGrepApi {
  parse: typeof parse;
  registerDynamicLanguage: typeof registerDynamicLanguage;
}

type Family = 'typescript' | 'python';

interface AstGrepRule extends NapiConfig {
  id: string;
  family: Family;
  severity: StaticSignal['severity'];
  message: string;
}

const RULES_DIR = join(__dirname, '..', 'rules', 'ast-grep');

const NAPI_VERSION = '0.51.1';

// ncc only bundles the native binding of the platform that builds `dist/`, and never the Python grammar, so both load at run time.
const NAPI_BUILDS: Record<string, { target: string; integrity: string }> = {
  'linux-x64': { target: 'linux-x64-gnu', integrity: 'sha512-qjPDrnHd6mO3JfQS4VZRN5/W1as58y2jgb6sdZcSHvKvpwpYgt9Rlr37r6cwH8riA4uNpATrVH4jMnsAgZGYKg==' },
  'linux-arm64': { target: 'linux-arm64-gnu', integrity: 'sha512-oUV+9XSdBwgMOneaG4qrDgDlbKOex/nwZ/xxN/LtrxHAN3y2DvUqG5Ds952F/shXJUxjqPRqsGUnB4chTpoj4Q==' },
  'darwin-x64': { target: 'darwin-x64', integrity: 'sha512-dB8Dm+B/aNPAxt6YUQEL3RWF/De9kbW/gdkG780lOpPOMD72injLbupiH/D1k6M76z6mTvqPQlTzTlXGmuxu3Q==' },
  'darwin-arm64': { target: 'darwin-arm64', integrity: 'sha512-kc9phT4a0wpM2GAjqn+RySI/pS7hET78TOvsjTdFeEnZ7tdh887wyqjp6+J1ZxVw+/N66m7TauoSLIzkqdeR1Q==' },
  'win32-x64': { target: 'win32-x64-msvc', integrity: 'sha512-MVgY2fgh/VHFLa+gpIPZLgwoXWeBIwz7gfJh79l71b9pJJm1F3c5fKzZNClnP362gV1e+svtJ0XiJXTUnCf52w==' },
};

const PYTHON_GRAMMAR: PinnedDownload = {
  url: 'https://registry.npmjs.org/@ast-grep/lang-python/-/lang-python-0.0.6.tgz',
  integrity: 'sha512-eF/bEBspmrxdVuPNihvZDyyJx5qtIpGEMz9l1nNQmrji7NZcUiRNC8WwzYyQCBdy1mj8HZ0Tn4I2q3gp/6Bkiw==',
};

const PYTHON_PREBUILDS: Record<string, string> = {
  'linux-x64': 'Linux-X64',
  'linux-arm64': 'Linux-ARM64',
  'darwin-x64': 'macOS-X64',
  'darwin-arm64': 'macOS-ARM64',
  'win32-x64': 'Windows-X64',
};

const LANGUAGES: Record<string, { family: Family; lang: string }> = {
  ts: { family: 'typescript', lang: 'TypeScript' },
  mts: { family: 'typescript', lang: 'TypeScript' },
  cts: { family: 'typescript', lang: 'TypeScript' },
  // The TSX grammar parses plain JavaScript and JSX, so the TypeScript rules cover JavaScript too.
  tsx: { family: 'typescript', lang: 'Tsx' },
  js: { family: 'typescript', lang: 'Tsx' },
  jsx: { family: 'typescript', lang: 'Tsx' },
  mjs: { family: 'typescript', lang: 'Tsx' },
  cjs: { family: 'typescript', lang: 'Tsx' },
  py: { family: 'python', lang: 'python' },
};

const FAMILIES: Record<string, Family> = { typescript: 'typescript', tsx: 'typescript', javascript: 'typescript', python: 'python' };

const SEVERITIES: Record<string, StaticSignal['severity']> = { error: 'error', warning: 'warning', info: 'note', hint: 'note' };

let loaded: Promise<AstGrepApi> | undefined;

/** Downloads the pinned `@ast-grep/napi` binding and Python grammar for this platform once per run and loads them. */
export function loadAstGrep(): Promise<AstGrepApi> {
  loaded ??= loadPinnedAstGrep();
  return loaded;
}

async function loadPinnedAstGrep(): Promise<AstGrepApi> {
  const platform = `${process.platform}-${process.arch}`;
  const build = NAPI_BUILDS[platform];
  if (!build) throw new Error(`no pinned ast-grep build for ${platform}`);
  const [bindingDir, grammarDir] = await Promise.all([
    installTarball({ url: `https://registry.npmjs.org/@ast-grep/napi-${build.target}/-/napi-${build.target}-${NAPI_VERSION}.tgz`, integrity: build.integrity }),
    installTarball(PYTHON_GRAMMAR),
  ]);
  const binding = { exports: {} };
  process.dlopen(binding, join(bindingDir, 'package', `ast-grep-napi.${build.target}.node`));
  const api = binding.exports as AstGrepApi;
  api.registerDynamicLanguage({
    python: {
      libraryPath: join(grammarDir, 'package', 'prebuilds', `prebuild-${PYTHON_PREBUILDS[platform]}`, 'parser.so'),
      extensions: ['py'],
      languageSymbol: 'tree_sitter_python',
      expandoChar: 'µ',
    },
  });
  return api;
}

/** Whether ast-grep has a grammar and rules for the file. */
export function isAstGrepFile(path: string): boolean {
  return languageOf(path) !== undefined;
}

/** Returns the results of Manki's rules in `rules/ast-grep` on each file, keyed by path. */
export function runAstGrep(api: AstGrepApi, files: Map<string, string>): StaticSignal[] {
  const rules = loadRules();
  const signals: StaticSignal[] = [];
  for (const [file, content] of files) {
    const language = languageOf(file);
    if (!language) continue;
    const root = api.parse(language.lang, content).root();
    for (const { id, family, severity, message, rule, constraints, utils } of rules) {
      if (family !== language.family) continue;
      try {
        for (const node of root.findAll({ rule, constraints, utils })) {
          signals.push({ tool: 'ast-grep', ruleId: id, severity, file, line: node.range().start.line + 1, message, source: 'ast_grep' });
        }
      } catch (error) {
        core.warning(`ast-grep: rule ${id} failed on ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return signals;
}

function languageOf(path: string): { family: Family; lang: string } | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : LANGUAGES[path.slice(dot + 1).toLowerCase()];
}

let rules: AstGrepRule[] | undefined;

function loadRules(): AstGrepRule[] {
  rules ??= readdirSync(RULES_DIR)
    .filter(name => name.endsWith('.yml'))
    .flatMap(name => parseAllDocuments(readFileSync(join(RULES_DIR, name), 'utf-8')).map(doc => {
      const { id, language, severity, message, rule, constraints, utils } = doc.toJS() as Record<string, unknown>;
      const family = FAMILIES[String(language).toLowerCase()];
      if (typeof id !== 'string' || !family || !SEVERITIES[String(severity)] || typeof message !== 'string' || !rule) {
        throw new Error(`invalid ast-grep rule ${String(id)} in ${name}`);
      }
      return { id, family, severity: SEVERITIES[String(severity)], message, rule, constraints, utils } as AstGrepRule;
    }));
  return rules;
}
