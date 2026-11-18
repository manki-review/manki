import { posix } from 'path';
import { validRange } from 'semver';
import { parse } from 'yaml';

import { namesTarball } from '../lockfile';
import { shown } from './shown';
import { PublishedVersion, Registry, RegistryConfig } from './types';

/** The host of the npm registry. */
const NPM_REGISTRY = 'https://registry.npmjs.org';

/** Yarn's own host for the npm registry, which a `yarn.lock` can name as a package's source. */
const YARN_REGISTRY = 'https://registry.yarnpkg.com';

/** The most bytes of a package's version list. A package with thousands of versions can list several MB. */
const MAX_METADATA_BYTES = 30 * 1024 * 1024;

/** The fields of a `package.json` that list dependencies. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** A requirement that names no version from the registry: an alias, a path, a git repository, a URL or a workspace link. */
const NOT_A_RANGE = /^(?:npm:|file:|link:|portal:|patch:|workspace:|git|github:|gitlab:|bitbucket:|https?:)|\//;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The settings files of a checkout that can set another registry. */
const REGISTRY_SETTINGS = ['.npmrc', '.yarnrc', '.yarnrc.yml'];

/** pnpm's hook files, whose code can change any package for an install. */
const PNPM_HOOKS = ['.pnpmfile.cjs', '.pnpmfile.mjs'];

/**
 * A patch `patch-package` applies after an install, filed under `patches/` as `<name>+<version>.patch`, with `+` for a
 * scope's `/`. A patch of a nested copy joins the path of packages with `++`, as `parent++name+1.0.0.patch`.
 */
const PATCH_PACKAGE = /(?:^|\/)patches\/[^/]+\.patch$/;

/**
 * Files that decide the versions or the code of the packages in their folder and below it, which Manki does not read:
 * the lockfiles and settings of Bun and Deno, pnpm's lockfile before version 3, and Rush's setup, which keeps its
 * lockfile in a folder of its own.
 */
const UNREAD_INSTALL_FILES = ['bun.lock', 'bun.lockb', 'bunfig.toml', 'deno.lock', 'deno.json', 'deno.jsonc', 'shrinkwrap.yaml', 'rush.json'];

/** The scripts a package manager runs when it installs the project, which can change any installed package. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies'];

/** Commands of an install script that change no installed package: Git hooks, and `patch-package`, whose patches Manki reads. */
const HARMLESS_COMMANDS = new Set(['husky', 'husky install', 'npx husky', 'npx husky install', 'is-ci', 'patch-package', 'npx patch-package', 'true']);

/** The settings of an `.npmrc` or a `.yarnrc` that change which lockfile or hook an install uses, with the value that does when only one does. */
const LOCKFILE_SETTINGS: ReadonlyArray<[string, string?]> = [
  ['package-lock', 'false'], ['lockfile', 'false'], ['lockfile-dir'], ['pnpmfile'], ['global-pnpmfile'], ['--no-lockfile'], ['--install.no-lockfile'], ['no-lockfile'],
];

/** The settings that make a fresh install pick another version than the highest a requirement allows. */
const PICK_SETTINGS = ['before', 'resolution-mode', 'minimum-release-age', 'resolutionMode', 'minimumReleaseAge', 'npmMinimalAgeGate'];

/** Whether a key of `overrides`, `resolutions` or a pnpm setting, at any depth of `table`, names the package `name`. */
function namesPackage(table: unknown, name: string): boolean {
  if (!isObject(table)) return false;
  // A key names a package alone or after its parents, as `parent/name`, `**/name` or `parent>name`, with an optional `@range`.
  const pattern = new RegExp(`(?:^|[/>])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:@|$)`);
  return Object.entries(table).some(([key, value]) => pattern.test(key) || namesPackage(value, name));
}

/** Whether `url` is the public npm registry, under npm's host or Yarn's. */
function isPublicRegistry(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return (hostname === new URL(NPM_REGISTRY).hostname || hostname === new URL(YARN_REGISTRY).hostname) && pathname === '/';
  } catch {
    return false;
  }
}

/** A registry a config file sets: for every package when `scope` is empty, else for the packages of `@scope`. */
interface RegistrySetting {
  scope: string;
  url: string;
}

/** Strips one pair of double quotes around `text`. */
function unquoted(text: string): string {
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/**
 * Returns the settings of an `.npmrc`, as `key=value`, or of a Yarn 1 `.yarnrc`, as `key value`, either side optionally
 * quoted. It splits each line at the first `=` or space with plain string search, so no line can make it slow.
 */
function lineSettings(text: string): Array<{ key: string; value: string }> {
  return text.split('\n').flatMap(raw => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) return [];
    let end: number;
    if (line.startsWith('"')) {
      end = line.indexOf('"', 1) + 1;
      if (end === 0) return [];
    } else {
      end = [...line].findIndex(c => c === '=' || c === ' ' || c === '\t');
      if (end < 0) end = line.length;
    }
    let value = line.slice(end).trim();
    if (value.startsWith('=')) value = value.slice(1).trim();
    return [{ key: unquoted(line.slice(0, end)), value: unquoted(value) }];
  });
}

/** Returns the top-level settings of a YAML settings file. Throws when it does not parse. */
function yamlSettings(text: string): Record<string, unknown> {
  const data: unknown = parse(text);
  return isObject(data) ? data : {};
}

/** Returns the settings of any settings file of `REGISTRY_SETTINGS` or `pnpm-workspace.yaml` as key and value. */
function settingsOf({ file, text }: RegistryConfig): Array<{ key: string; value: unknown }> {
  const base = posix.basename(file);
  if (base === '.yarnrc.yml' || base === 'pnpm-workspace.yaml') return Object.entries(yamlSettings(text)).map(([key, value]) => ({ key, value }));
  return REGISTRY_SETTINGS.includes(base) ? lineSettings(text) : [];
}

/**
 * Returns the registries `config` sets: `registry` and `@scope:registry` in an `.npmrc` or a Yarn 1 `.yarnrc`, and
 * `npmRegistryServer` and `npmScopes` in a `.yarnrc.yml`. A `.yarnrc.yml` that does not parse sets an unknown one.
 */
function registrySettings({ file, text }: RegistryConfig): RegistrySetting[] {
  if (posix.basename(file) === '.yarnrc.yml') {
    let data: unknown;
    try {
      data = parse(text);
    } catch {
      return [{ scope: '', url: 'a setting Manki cannot read' }];
    }
    if (!isObject(data)) return [];
    const scopes = isObject(data.npmScopes) ? data.npmScopes : {};
    return [
      ...(data.npmRegistryServer !== undefined ? [{ scope: '', url: String(data.npmRegistryServer) }] : []),
      ...Object.entries(scopes).flatMap(([scope, entry]) => (isObject(entry) && entry.npmRegistryServer !== undefined ? [{ scope: `@${scope.replace(/^@/, '')}`, url: String(entry.npmRegistryServer) }] : [])),
    ];
  }
  return lineSettings(text).flatMap(({ key, value }) => {
    if (key === 'registry') return [{ scope: '', url: value }];
    const scope = key.endsWith(':registry') ? key.slice(0, -':registry'.length) : '';
    return scope.startsWith('@') && scope.length > 1 ? [{ scope, url: value }] : [];
  });
}

/** Whether the install script `script` runs only commands of `HARMLESS_COMMANDS`, joined by `&&`, `||` or `;`. */
function harmlessScript(script: string): boolean {
  return script.split('&&').flatMap(part => part.split('||')).flatMap(part => part.split(';')).every(command => HARMLESS_COMMANDS.has(command.trim()));
}

/** Whether a patch-package file named `base` names the package `name` in any part of its path, as the patched package or a parent of it. */
function patchesPackage(base: string, name: string): boolean {
  const spelled = name.replace('/', '+');
  return base.slice(0, -'.patch'.length).split('++').some(part => part === spelled || part.startsWith(`${spelled}+`));
}

/** The npm registry, of JavaScript packages. */
export function npmRegistry(registry = NPM_REGISTRY, maxMetadataBytes = MAX_METADATA_BYTES): Registry {
  return {
    id: 'npm',
    origins: [new URL(registry).origin],
    manifests: ['package.json'],
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'],
    unreadInstallFiles: UNREAD_INSTALL_FILES,
    validName: name => name.length <= 214 && /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name),
    sameName: (a, b) => a === b,
    isRegistrySource(source, name, version) {
      // Yarn 2 and later write `npm`, and pnpm writes no URL, for the registry the project is set up with.
      if (source === 'npm' || source === 'registry') return true;
      if (!source?.startsWith('https://')) return false;
      try {
        const { origin } = new URL(source);
        // An alias locks another package's archive under this name, which the archive's path shows.
        return (origin === NPM_REGISTRY || origin === YARN_REGISTRY) && namesTarball(source, name, version);
      } catch {
        return false;
      }
    },
    namesHost: source => source !== 'npm' && source !== 'registry',
    isConfigFile: path => [...REGISTRY_SETTINGS, ...PNPM_HOOKS, 'pnpm-workspace.yaml'].includes(posix.basename(path)) || PATCH_PACKAGE.test(path),
    otherRegistry(name, configs) {
      const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined;
      const settings = configs.filter(c => REGISTRY_SETTINGS.includes(posix.basename(c.file))).flatMap(config => registrySettings(config).map(setting => ({ ...setting, file: config.file })));
      // A scope's own registry decides for its packages. Without one, the default registry does.
      const scoped = settings.filter(s => scope !== undefined && s.scope === scope);
      const other = (scoped.length > 0 ? scoped : settings.filter(s => s.scope === '')).find(s => !isPublicRegistry(s.url));
      return other && `${shown(other.file)} sets the registry ${shown(other.url.slice(0, 100))}${scoped.length > 0 ? ` for ${shown(scope!)}` : ''}`;
    },
    overriddenBy(name, configs) {
      for (const config of configs) {
        const { file, text } = config;
        const base = posix.basename(file);
        if (PNPM_HOOKS.includes(base)) return `${shown(file)} is a pnpm hook, which can change any package`;
        if (PATCH_PACKAGE.test(file)) {
          if (patchesPackage(base, name)) return `${shown(file)} patches it after an install`;
          continue;
        }
        if (base === 'pnpm-workspace.yaml') {
          const workspace = yamlSettings(text);
          if (namesPackage(workspace.overrides, name) || namesPackage(workspace.patchedDependencies, name)) return `${shown(file)} overrides or patches it`;
          if (workspace.pnpmfile !== undefined) return `${shown(file)} sets a pnpm hook, which can change any package`;
        }
        if (base === '.yarnrc.yml') {
          const settings = yamlSettings(text);
          if (settings.lockfileFilename !== undefined) return `${shown(file)} sets another lockfile name, so Manki cannot tell which lockfile an install reads`;
          // Yarn's own plugins add commands and protocols but change no package from the registry.
          const plugins = Array.isArray(settings.plugins) ? settings.plugins : settings.plugins === undefined ? [] : [settings.plugins];
          const foreign = plugins.find(plugin => !(isObject(plugin) && typeof plugin.spec === 'string' && plugin.spec.startsWith('@yarnpkg/plugin-')));
          if (foreign !== undefined) return `${shown(file)} loads a Yarn plugin other than Yarn's own, which can change any package`;
        }
        const lockfile = settingsOf(config).find(({ key, value }) => LOCKFILE_SETTINGS.some(([k, v]) => k === key && (v === undefined || String(value) === v)));
        if (lockfile) return `${shown(file)} sets \`${lockfile.key}\`, so Manki cannot tell which lockfile or hook an install uses`;
      }
      return undefined;
    },
    freshPick(files) {
      for (const config of files) {
        const setting = settingsOf(config).find(({ key }) => PICK_SETTINGS.includes(key));
        if (setting) return `${shown(config.file)} sets \`${setting.key}\`, so a fresh install may not pick the highest version a requirement allows`;
      }
      return undefined;
    },
    manifest(text, name) {
      const manifest: unknown = JSON.parse(text);
      if (!isObject(manifest)) throw new Error('the manifest is not an object');
      const requirements = DEPENDENCY_FIELDS.flatMap(field => {
        const deps = manifest[field];
        const requirement = isObject(deps) && Object.hasOwn(deps, name) ? deps[name] : undefined;
        return typeof requirement === 'string' ? [{ name, requirement }] : [];
      });
      const pnpm = isObject(manifest.pnpm) ? manifest.pnpm : {};
      const field = (
        [['overrides', manifest.overrides], ['resolutions', manifest.resolutions], ['patchedDependencies', manifest.patchedDependencies], ['pnpm.overrides', pnpm.overrides], ['pnpm.patchedDependencies', pnpm.patchedDependencies]] as const
      ).find(([, table]) => namesPackage(table, name))?.[0];
      const scripts = isObject(manifest.scripts) ? manifest.scripts : {};
      const script = INSTALL_SCRIPTS.find(s => Object.hasOwn(scripts, s) && !(typeof scripts[s] === 'string' && harmlessScript(scripts[s])));
      const overridden = field ? `its \`${field}\` names it`
        : script ? `its \`${script}\` script runs at install and can change any installed package`
          : manifest.name === name ? 'it is a package of the checkout with that name, which a workspace install can link in its place'
            : undefined;
      return { requirements, ...(overridden && { overridden }) };
    },
    range(requirement) {
      const range = requirement.trim() || '*';
      return NOT_A_RANGE.test(range) || !validRange(range) ? undefined : range;
    },
    async published(name, fetch) {
      // The short form npm itself installs from, which leaves out each version's readme.
      const data: unknown = JSON.parse((await fetch(`${registry}/${name.replace('/', '%2f')}`, maxMetadataBytes, { accept: 'application/vnd.npm.install-v1+json' })).toString('utf8'));
      const versions = isObject(data) && isObject(data.versions) ? data.versions : {};
      const latest = isObject(data) && isObject(data['dist-tags']) ? data['dist-tags'].latest : undefined;
      return {
        name: isObject(data) && typeof data.name === 'string' ? data.name : name,
        ...(typeof latest === 'string' && { latest }),
        versions: Object.entries(versions).flatMap(([version, entry]): PublishedVersion[] => {
          const dist = isObject(entry) && isObject(entry.dist) ? entry.dist : {};
          const checksum = typeof dist.integrity === 'string' ? dist.integrity : typeof dist.shasum === 'string' ? dist.shasum : undefined;
          if (!checksum) return [];
          // npm itself takes an empty message as no deprecation, which `npm deprecate` leaves when it lifts one.
          return [{ version, checksum, ...(isObject(entry) && typeof entry.deprecated === 'string' && entry.deprecated !== '' && { deprecated: true as const }) }];
        }),
      };
    },
    archiveUrl(name, version) {
      const base = name.slice(name.lastIndexOf('/') + 1);
      return `${registry}/${name}/-/${base}-${encodeURIComponent(version)}.tgz`;
    },
  };
}
