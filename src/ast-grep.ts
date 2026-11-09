import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import * as core from '@actions/core';
import type { NapiConfig, parse, registerDynamicLanguage } from '@ast-grep/napi';
import { minimatch } from 'minimatch';
import { parseAllDocuments } from 'yaml';

import { installPinned, PinnedDownload } from './tool-install';
import { StaticSignal } from './types';

/** The part of `@ast-grep/napi` the analyzer uses, with the Go, Python and Rust grammars registered as `go`, `python` and `rust`. */
export interface AstGrepApi {
  parse: typeof parse;
  registerDynamicLanguage: typeof registerDynamicLanguage;
}

/** The language families Manki's ast-grep can parse. */
export const AST_GREP_FAMILIES = ['typescript', 'python', 'rust', 'go'] as const;

type Family = typeof AST_GREP_FAMILIES[number];

interface AstGrepRule extends NapiConfig {
  id: string;
  family: Family;
  severity: StaticSignal['severity'];
  message: string;
  /** Globs of files the rule skips. */
  ignores: string[];
}

const RULES_DIR = join(__dirname, '..', 'rules', 'ast-grep');

const NAPI_VERSION = '0.51.1';

// ncc only bundles the native binding of the platform that builds `dist/`, and never the grammars, so all of them load at run time.
const NAPI_BUILDS: Record<string, { target: string; integrity: string }> = {
  'linux-x64': { target: 'linux-x64-gnu', integrity: 'sha512-qjPDrnHd6mO3JfQS4VZRN5/W1as58y2jgb6sdZcSHvKvpwpYgt9Rlr37r6cwH8riA4uNpATrVH4jMnsAgZGYKg==' },
  'linux-arm64': { target: 'linux-arm64-gnu', integrity: 'sha512-oUV+9XSdBwgMOneaG4qrDgDlbKOex/nwZ/xxN/LtrxHAN3y2DvUqG5Ds952F/shXJUxjqPRqsGUnB4chTpoj4Q==' },
  'darwin-x64': { target: 'darwin-x64', integrity: 'sha512-dB8Dm+B/aNPAxt6YUQEL3RWF/De9kbW/gdkG780lOpPOMD72injLbupiH/D1k6M76z6mTvqPQlTzTlXGmuxu3Q==' },
  'darwin-arm64': { target: 'darwin-arm64', integrity: 'sha512-kc9phT4a0wpM2GAjqn+RySI/pS7hET78TOvsjTdFeEnZ7tdh887wyqjp6+J1ZxVw+/N66m7TauoSLIzkqdeR1Q==' },
  'win32-x64': { target: 'win32-x64-msvc', integrity: 'sha512-MVgY2fgh/VHFLa+gpIPZLgwoXWeBIwz7gfJh79l71b9pJJm1F3c5fKzZNClnP362gV1e+svtJ0XiJXTUnCf52w==' },
};

const GO_GRAMMAR: PinnedDownload = {
  url: 'https://registry.npmjs.org/@ast-grep/lang-go/-/lang-go-0.0.6.tgz',
  integrity: 'sha512-PZap9Rp6t+YKbLjRnFRF5aGBX3/HV9s5Rp7ZPsCM+o3tlTZDo1IqDYnFu+Oeh5Razs2U8K8ccPSJ+GBxalVhWg==',
};

const PYTHON_GRAMMAR: PinnedDownload = {
  url: 'https://registry.npmjs.org/@ast-grep/lang-python/-/lang-python-0.0.6.tgz',
  integrity: 'sha512-eF/bEBspmrxdVuPNihvZDyyJx5qtIpGEMz9l1nNQmrji7NZcUiRNC8WwzYyQCBdy1mj8HZ0Tn4I2q3gp/6Bkiw==',
};

const RUST_GRAMMAR: PinnedDownload = {
  url: 'https://registry.npmjs.org/@ast-grep/lang-rust/-/lang-rust-0.0.7.tgz',
  integrity: 'sha512-CF6jv8XmlVQgr/pFKADM87EkoGiHIrHKsG1wcX2iqgdBX5kW8wH+Zd4GP6SMme2eZogD49f19vRoRTF44iZqzg==',
};

const GRAMMAR_PREBUILDS: Record<string, string> = {
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
  rs: { family: 'rust', lang: 'rust' },
  go: { family: 'go', lang: 'go' },
};

const FAMILIES: Record<string, Family> = { typescript: 'typescript', tsx: 'typescript', javascript: 'typescript', python: 'python', rust: 'rust', go: 'go' };

const SEVERITIES: Record<string, StaticSignal['severity']> = { error: 'error', warning: 'warning', info: 'note', hint: 'note' };

let loaded: Promise<AstGrepApi> | undefined;

/** Downloads the pinned `@ast-grep/napi` binding and the Go, Python and Rust grammars for this platform once per run and loads them. */
export function loadAstGrep(): Promise<AstGrepApi> {
  loaded ??= loadPinnedAstGrep();
  return loaded;
}

async function loadPinnedAstGrep(): Promise<AstGrepApi> {
  const platform = `${process.platform}-${process.arch}`;
  const build = NAPI_BUILDS[platform];
  if (!build) throw new Error(`no pinned ast-grep build for ${platform}`);
  const [bindingDir, goDir, pythonDir, rustDir] = await Promise.all([
    installPinned({ url: `https://registry.npmjs.org/@ast-grep/napi-${build.target}/-/napi-${build.target}-${NAPI_VERSION}.tgz`, integrity: build.integrity }),
    installPinned(GO_GRAMMAR),
    installPinned(PYTHON_GRAMMAR),
    installPinned(RUST_GRAMMAR),
  ]);
  const parser = (dir: string) => join(dir, 'package', 'prebuilds', `prebuild-${GRAMMAR_PREBUILDS[platform]}`, 'parser.so');
  const binding = { exports: {} };
  process.dlopen(binding, join(bindingDir, 'package', `ast-grep-napi.${build.target}.node`));
  const api = binding.exports as AstGrepApi;
  api.registerDynamicLanguage({
    go: { libraryPath: parser(goDir), extensions: ['go'], languageSymbol: 'tree_sitter_go', expandoChar: 'µ' },
    python: { libraryPath: parser(pythonDir), extensions: ['py'], languageSymbol: 'tree_sitter_python', expandoChar: 'µ' },
    rust: { libraryPath: parser(rustDir), extensions: ['rs'], languageSymbol: 'tree_sitter_rust', expandoChar: 'µ' },
  });
  return api;
}

/** Whether ast-grep has a grammar and rules for the file. */
export function isAstGrepFile(path: string): boolean {
  const family = languageOf(path)?.family;
  return family !== undefined && loadRules().some(rule => rule.family === family);
}

/** Returns the results of Manki's rules in `rules/ast-grep` on each file, keyed by path. */
export function runAstGrep(api: AstGrepApi, files: Map<string, string>): StaticSignal[] {
  const rules = loadRules();
  const signals: StaticSignal[] = [];
  for (const [file, content] of files) {
    const language = languageOf(file);
    if (!language) continue;
    const root = api.parse(language.lang, content).root();
    for (const { id, family, severity, message, rule, constraints, utils, ignores } of rules) {
      if (family !== language.family || ignores.some(glob => minimatch(file, glob))) continue;
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

/** Whether the file is Rust. Manki's Rust rules run only in a repository with a `Cargo.toml`. */
export function isRustFile(path: string): boolean {
  return languageOf(path)?.family === 'rust';
}

/** Returns the language family and ast-grep language of the file, or `undefined` when ast-grep cannot parse it. */
export function languageOf(path: string): { family: Family; lang: string } | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : LANGUAGES[path.slice(dot + 1).toLowerCase()];
}

let rules: AstGrepRule[] | undefined;

function loadRules(): AstGrepRule[] {
  rules ??= readdirSync(RULES_DIR)
    .filter(name => name.endsWith('.yml'))
    .flatMap(name => {
      const docs = parseAllDocuments(readFileSync(join(RULES_DIR, name), 'utf-8')).map(doc => doc.toJS() as Record<string, unknown>);
      // A document without an `id` holds `utils` and `ignores` shared by every rule in its file.
      const shared = docs.filter(doc => doc.id === undefined);
      const sharedUtils = Object.assign({}, ...shared.map(doc => doc.utils));
      const sharedIgnores = shared.flatMap(doc => (doc.ignores ?? []) as string[]);
      return docs.filter(doc => doc.id !== undefined).map(({ id, language, severity, message, rule, constraints, utils, ignores }) => {
        const family = FAMILIES[String(language).toLowerCase()];
        if (typeof id !== 'string' || !family || !SEVERITIES[String(severity)] || typeof message !== 'string' || !rule) {
          throw new Error(`invalid ast-grep rule ${String(id)} in ${name}`);
        }
        return {
          id, family, severity: SEVERITIES[String(severity)], message, rule, constraints,
          utils: { ...sharedUtils, ...(utils as object) }, ignores: [...sharedIgnores, ...((ignores ?? []) as string[])],
        } as AstGrepRule;
      });
    });
  return rules;
}
