import { execFile } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';

import { addedLines } from './diff';
import { installPinned, makeScratchDir, PinnedDownload } from './tool-install';
import { DiffFile, PackageVulnerability, StaticSignal } from './types';

export type BinaryTool = 'gitleaks' | 'osv-scanner' | 'opengrep';

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Installs and runs the pinned analyzer binaries. */
export interface ToolRunner {
  /** Returns the path of the tool's binary for this platform. */
  installTool: (tool: BinaryTool) => Promise<string>;
  runTool: (binary: string, args: string[], cwd: string) => Promise<ToolResult>;
}

const RULES_DIR = join(__dirname, '..', 'rules');
const TOOL_TIMEOUT_MS = 300_000;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;

// A tool reads these as its own config or ignore list, so a PR could add one to hide a result. They are never scanned.
const TOOL_CONFIG_FILES = new Set(['.gitleaks.toml', '.gitleaksignore', '.semgrepignore', '.gitignore', 'osv-scanner.toml']);

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock',
  'Cargo.lock', 'go.mod', 'poetry.lock', 'Pipfile.lock', 'pdm.lock', 'uv.lock', 'requirements.txt',
  'Gemfile.lock', 'gems.locked', 'composer.lock', 'pubspec.lock', 'mix.lock', 'packages.lock.json',
  'gradle.lockfile', 'buildscript-gradle.lockfile', 'renv.lock', 'conan.lock',
]);

const GITLEAKS = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1';
const OSV_SCANNER = 'https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner';
const OPENGREP = 'https://github.com/opengrep/opengrep/releases/download/v1.33.1/opengrep';

type Build = PinnedDownload & { binary: string };

const BUILDS: Record<BinaryTool, Record<string, Build>> = {
  gitleaks: {
    'linux-x64': { url: `${GITLEAKS}_linux_x64.tar.gz`, integrity: 'sha256-VR9vyD6kV9YqDZgjfLrRBa+NVXADBR9B8+fKez8kcOs=', binary: 'gitleaks' },
    'linux-arm64': { url: `${GITLEAKS}_linux_arm64.tar.gz`, integrity: 'sha256-5KSH7nzNfTp/fsCGV2EKo2BmN9q5JCELOu5iVw+0sIA=', binary: 'gitleaks' },
    'darwin-x64': { url: `${GITLEAKS}_darwin_x64.tar.gz`, integrity: 'sha256-3+EBpNsiVfyFEgrH89JeQ0LDwgz3SfLCChgIGvGVJwk=', binary: 'gitleaks' },
    'darwin-arm64': { url: `${GITLEAKS}_darwin_arm64.tar.gz`, integrity: 'sha256-tAqwrlXFBZY+Nl8nGo04Ru+8FwqhfyYH8T32EKmutqU=', binary: 'gitleaks' },
    'win32-x64': { url: `${GITLEAKS}_windows_x64.zip`, integrity: 'sha256-0pFE3v86aKqTztM93fhLf9wmBwrdSqD0UTCUyDMq/E4=', binary: 'gitleaks.exe' },
  },
  'osv-scanner': {
    'linux-x64': { url: `${OSV_SCANNER}_linux_amd64`, integrity: 'sha256-FgxiU+KSLp4KapdxxcTECks8YJCzSjzdXoDJbMLkIYs=', binary: 'osv-scanner_linux_amd64' },
    'linux-arm64': { url: `${OSV_SCANNER}_linux_arm64`, integrity: 'sha256-QGHvTAIe08R/IDuBjzN+NRM2zFzWfAJ0/Da9Hfxyjdc=', binary: 'osv-scanner_linux_arm64' },
    'darwin-x64': { url: `${OSV_SCANNER}_darwin_amd64`, integrity: 'sha256-6Cxd96sKQt/ymhzQZgcRRHtWtMBIP/Zq2GNN8Q/YGkU=', binary: 'osv-scanner_darwin_amd64' },
    'darwin-arm64': { url: `${OSV_SCANNER}_darwin_arm64`, integrity: 'sha256-1JJu+NoTQzJUO+J23/FX5MFw+ZrZH8SOiUSKiBa99ws=', binary: 'osv-scanner_darwin_arm64' },
    'win32-x64': { url: `${OSV_SCANNER}_windows_amd64.exe`, integrity: 'sha256-mWTtZOyaOHOR60zABq1cUxFUghrvKbeT4CxEjeRoZDg=', binary: 'osv-scanner_windows_amd64.exe' },
  },
  opengrep: {
    'linux-x64': { url: `${OPENGREP}_manylinux_x86`, integrity: 'sha256-RugTPMSQ+fUFGAYVkM4va+WgivrtoDRHHAztpLOJmAg=', binary: 'opengrep_manylinux_x86' },
    'linux-arm64': { url: `${OPENGREP}_manylinux_aarch64`, integrity: 'sha256-0UM/Y6kLi8C2rUtJihOzcrhWzpp1SkNIS6SSD+LXbc8=', binary: 'opengrep_manylinux_aarch64' },
    'darwin-x64': { url: `${OPENGREP}_osx_x86`, integrity: 'sha256-w70Y4NiY1E4oQZ2V2tV8iSi7RqsyiJoO4fcqh62WJ68=', binary: 'opengrep_osx_x86' },
    'darwin-arm64': { url: `${OPENGREP}_osx_arm64`, integrity: 'sha256-oXwYgbtA4yFCZqeikc9PKuO8VsFxVii1cS0uyBa8Pi0=', binary: 'opengrep_osx_arm64' },
    'win32-x64': { url: `${OPENGREP}_windows_x86.exe`, integrity: 'sha256-Ey5gbgcb3TkoKG/dyJMZimEGqQgg1G4hGX4Kzhoj4ME=', binary: 'opengrep_windows_x86.exe' },
  },
};

const SEMGREP_SEVERITY: Record<string, StaticSignal['severity']> = {
  CRITICAL: 'error', HIGH: 'error', ERROR: 'error', MEDIUM: 'warning', WARNING: 'warning',
};

/** Downloads the pinned build of the tool for this platform, once per run, and returns its binary. */
export async function installTool(tool: BinaryTool): Promise<string> {
  const platform = `${process.platform}-${process.arch}`;
  const build = BUILDS[tool][platform];
  if (!build) throw new Error(`no pinned ${tool} build for ${platform}`);
  return join(await installPinned(build), build.binary);
}

/** Runs a tool without the action's environment, so it never sees a token. Resolves with the exit code instead of throwing. */
export function runTool(binary: string, args: string[], cwd: string): Promise<ToolResult> {
  const env: NodeJS.ProcessEnv = { HOME: makeScratchDir('home') };
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.USERPROFILE = env.HOME;
  return new Promise(resolvePromise => {
    execFile(binary, args, { cwd, env, timeout: TOOL_TIMEOUT_MS, maxBuffer: MAX_TOOL_OUTPUT_BYTES }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolvePromise({ code, stdout, stderr: stderr || error?.message || '' });
    });
  });
}

/** Whether OSV-Scanner reads the file as a lockfile. */
export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

/**
 * Returns the secrets gitleaks finds on the lines the diff adds. Runs with Manki's config, so the repository's
 * gitleaks config and `gitleaks:allow` comments cannot hide a secret.
 */
export async function runGitleaks(files: DiffFile[], tools: ToolRunner): Promise<StaticSignal[]> {
  // Each file keeps only its added lines, at their own line numbers, so a result's line is its line in the PR.
  const added = new Map(files.flatMap(file => {
    const lines = addedLines(file);
    if (lines.size === 0) return [];
    return [[file.path, Array.from({ length: [...lines.keys()].at(-1)! }, (_, i) => lines.get(i + 1) ?? '').join('\n')]];
  }));
  if (added.size === 0) return [];
  const binary = await tools.installTool('gitleaks');
  const root = writeScanTree(added);
  const output = await runChecked(tools, 'gitleaks', binary, [
    'dir', '.', '--config', join(RULES_DIR, 'gitleaks.toml'), '--ignore-gitleaks-allow', '--redact', '--no-banner',
    '--log-level', 'error', '--exit-code', '0', '--report-format', 'json', '--report-path', '-',
  ], root, [0]);
  const leaks = JSON.parse(output) as Array<{ RuleID: string; Description: string; StartLine: number; File: string }>;
  return leaks.map(leak => ({
    tool: 'gitleaks', ruleId: leak.RuleID, severity: 'error', file: repoPath(root, leak.File), line: leak.StartLine,
    message: leak.Description, source: 'secrets',
  }));
}

/** Returns the known vulnerabilities OSV-Scanner reports in `lockfiles`, which maps each path to its content. */
export async function runOsvScanner(lockfiles: Map<string, string>, tools: ToolRunner): Promise<PackageVulnerability[]> {
  if (lockfiles.size === 0) return [];
  const binary = await tools.installTool('osv-scanner');
  const root = writeScanTree(lockfiles);
  // Exit code 1 means vulnerabilities were found, and 128 that a lockfile lists no packages.
  const output = await runChecked(tools, 'osv-scanner', binary, [
    'scan', 'source', '--config', join(RULES_DIR, 'osv-scanner.toml'), '--format', 'json', '--no-resolve',
    '--no-call-analysis=all', '--verbosity', 'error', ...[...lockfiles.keys()].flatMap(path => ['-L', path]),
  ], root, [0, 1, 128]);
  if (!output.trim()) return [];
  const { results } = JSON.parse(output) as OsvOutput;
  return (results ?? []).flatMap(result => (result.packages ?? []).flatMap(({ package: pkg, vulnerabilities, groups }) => {
    const summaries = new Map((vulnerabilities ?? []).map(v => [v.id, v.summary]));
    // A group joins the advisories that describe one vulnerability, such as a GHSA and its CVE.
    return (groups ?? []).map((group): PackageVulnerability => {
      const id = [...group.ids, ...(group.aliases ?? [])].find(a => a.startsWith('GHSA-')) ?? group.ids[0];
      const score = Number.parseFloat(group.max_severity ?? '');
      return {
        manifest: repoPath(root, result.source.path), name: pkg.name, version: pkg.version, id,
        severity: score >= 7 ? 'error' : score >= 4 || Number.isNaN(score) ? 'warning' : 'note',
        summary: group.ids.map(i => summaries.get(i)).find(Boolean),
      };
    });
  }));
}

/** Returns the results of the user's Semgrep rules on the files, run by Opengrep with `nosemgrep` comments ignored. */
export async function runOpengrep(rules: string[], files: Map<string, string>, tools: ToolRunner): Promise<StaticSignal[]> {
  if (files.size === 0) return [];
  const binary = await tools.installTool('opengrep');
  const root = writeScanTree(files);
  const rulesDir = makeScratchDir('semgrep-rules');
  const configs = rules.flatMap((content, i) => {
    const path = join(rulesDir, `rules-${i}.yml`);
    writeFileSync(path, content);
    return ['--config', path];
  });
  const output = await runChecked(tools, 'opengrep', binary, [
    'scan', ...configs, '--json', '--disable-nosem', '--disable-version-check', '--no-git-ignore', '--no-rewrite-rule-ids', '--quiet', '.',
  ], root, [0]);
  const { results } = JSON.parse(output) as { results: Array<{ check_id: string; path: string; start: { line: number }; extra: { message: string; severity: string } }> };
  return results.map(r => ({
    tool: 'opengrep', ruleId: r.check_id, severity: SEMGREP_SEVERITY[r.extra.severity] ?? 'note', file: repoPath(root, r.path),
    line: r.start.line, message: r.extra.message, source: 'semgrep',
  }));
}

interface OsvOutput {
  results?: Array<{
    source: { path: string };
    packages?: Array<{
      package: { name: string; version: string };
      vulnerabilities?: Array<{ id: string; summary?: string }>;
      groups?: Array<{ ids: string[]; aliases?: string[]; max_severity?: string }>;
    }>;
  }>;
}

async function runChecked(tools: ToolRunner, tool: BinaryTool, binary: string, args: string[], cwd: string, okCodes: number[]): Promise<string> {
  const { code, stdout, stderr } = await tools.runTool(binary, args, cwd);
  if (!okCodes.includes(code)) throw new Error(`${tool} exited with code ${code}: ${stderr.trim().split('\n').at(-1) ?? ''}`);
  return stdout;
}

/** Writes the files under a new directory at their repository paths and returns the directory. */
function writeScanTree(files: Map<string, string>): string {
  const root = makeScratchDir('scan');
  for (const [path, content] of files) {
    const target = resolve(root, path);
    if (TOOL_CONFIG_FILES.has(basename(path)) || !target.startsWith(root + sep)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function repoPath(root: string, toolPath: string): string {
  return relative(root, resolve(root, toolPath)).split(sep).join('/');
}
