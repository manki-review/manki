import { validRange } from 'semver';

import { PublishedVersion, Registry } from './types';

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

/** The npm registry, of JavaScript packages. */
export function npmRegistry(registry = NPM_REGISTRY): Registry {
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
      const origin = new URL(source).origin;
      return origin === NPM_REGISTRY || origin === YARN_REGISTRY;
    },
    requirements(text, name) {
      const manifest: unknown = JSON.parse(text);
      if (!isObject(manifest)) return [];
      return DEPENDENCY_FIELDS.flatMap(field => {
        const deps = manifest[field];
        const requirement = isObject(deps) && Object.hasOwn(deps, name) ? deps[name] : undefined;
        return typeof requirement === 'string' ? [requirement] : [];
      });
    },
    range(requirement) {
      const range = requirement.trim() || '*';
      return NOT_A_RANGE.test(range) || !validRange(range) ? undefined : range;
    },
    async published(name, fetch) {
      // The short form npm itself installs from, which leaves out each version's readme.
      const data: unknown = JSON.parse((await fetch(`${registry}/${name.replace('/', '%2f')}`, MAX_METADATA_BYTES, { accept: 'application/vnd.npm.install-v1+json' })).toString('utf8'));
      const versions = isObject(data) && isObject(data.versions) ? data.versions : {};
      return {
        name: isObject(data) && typeof data.name === 'string' ? data.name : name,
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
