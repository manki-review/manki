import { posix } from 'path';
import { validRange } from 'semver';
import { parse } from 'yaml';

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
  // `key=value` in an `.npmrc`, and `key value` in a `.yarnrc`, either side optionally quoted.
  return text.split('\n').flatMap(line => {
    const setting = /^\s*"?(?:(@[^:\s"=]+):)?registry"?\s*(?:=|\s)\s*"?([^"]*?)"?\s*$/.exec(line);
    return setting ? [{ scope: setting[1] ?? '', url: setting[2] }] : [];
  });
}

/** The npm registry, of JavaScript packages. */
export function npmRegistry(registry = NPM_REGISTRY, maxMetadataBytes = MAX_METADATA_BYTES): Registry {
  return {
    id: 'npm',
    origins: [new URL(registry).origin],
    manifests: ['package.json'],
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'],
    validName: name => name.length <= 214 && /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name),
    sameName: (a, b) => a === b,
    isRegistrySource(source) {
      // Yarn 2 and later write `npm`, and pnpm writes no URL, for the registry the project is set up with.
      if (source === 'npm' || source === 'registry') return true;
      if (!source || !/^https:\/\//.test(source)) return false;
      try {
        const { origin } = new URL(source);
        return origin === NPM_REGISTRY || origin === YARN_REGISTRY;
      } catch {
        return false;
      }
    },
    namesHost: source => source !== 'npm' && source !== 'registry',
    configFiles: ['.npmrc', '.yarnrc', '.yarnrc.yml'],
    otherRegistry(name, configs) {
      const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined;
      const settings = configs.flatMap(config => registrySettings(config).map(setting => ({ ...setting, file: config.file })));
      // A scope's own registry decides for its packages. Without one, the default registry does.
      const scoped = settings.filter(s => scope !== undefined && s.scope === scope);
      const other = (scoped.length > 0 ? scoped : settings.filter(s => s.scope === '')).find(s => !isPublicRegistry(s.url));
      return other && `${other.file} sets the registry ${other.url.slice(0, 100)}${scoped.length > 0 ? ` for ${scope}` : ''}`;
    },
    requirements(text, name) {
      const manifest: unknown = JSON.parse(text);
      if (!isObject(manifest)) return [];
      return DEPENDENCY_FIELDS.flatMap(field => {
        const deps = manifest[field];
        const requirement = isObject(deps) && Object.hasOwn(deps, name) ? deps[name] : undefined;
        return typeof requirement === 'string' ? [{ name, requirement }] : [];
      });
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
          return [{ version, checksum, ...(isObject(entry) && typeof entry.deprecated === 'string' && { deprecated: true as const }) }];
        }),
      };
    },
    archiveUrl(name, version) {
      const base = name.slice(name.lastIndexOf('/') + 1);
      return `${registry}/${name}/-/${base}-${encodeURIComponent(version)}.tgz`;
    },
  };
}
