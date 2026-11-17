/** Downloads a URL of the registry's own hosts whole, with at most `maxBytes`. Throws for any other host. */
export type RegistryFetch = (url: string, maxBytes: number, headers?: Record<string, string>) => Promise<Buffer>;

/** One published version of a package, with the checksum the registry states for its archive. */
export interface PublishedVersion {
  version: string;
  checksum: string;
  /** Pulled from the registry, so no new install picks it. */
  yanked?: true;
  /** Marked deprecated, so an install picks it only when no other version matches. */
  deprecated?: true;
}

/**
 * A package registry Manki reads dependency sources from. Each one is a module of its own under `src/registries`, and
 * only its fixed hosts are ever contacted.
 */
export interface Registry {
  /** Names a package of the registry as `<id>/<name>`, such as `crates.io/time`. */
  id: string;
  /** The origins, such as `https://index.crates.io`, that the registry may be fetched from. */
  origins: readonly string[];
  /** The file names of the manifests that state requirements. */
  manifests: readonly string[];
  /** The file names of the lockfiles that lock versions. `lockedPackages` parses each of them. */
  lockfiles: readonly string[];
  /** Whether `name` is a valid package name of the registry. No other name reaches a URL. */
  validName(name: string): boolean;
  /** Whether two spellings name the same package, such as `serde_json` and `serde-json` on crates.io. */
  sameName(a: string, b: string): boolean;
  /** Whether a lockfile's source for a package names this registry, the only source Manki reads a package from. */
  isRegistrySource(source: string | undefined): boolean;
  /** Returns the requirements a manifest's `text` states for the package `name`, in the manifest's own syntax. */
  requirements(text: string, name: string): string[];
  /** Returns the semver range of a requirement, or `undefined` for one that names no registry version, such as a path or a git source. */
  range(requirement: string): string | undefined;
  /** Returns the package's own name as the registry spells it, and its published versions. */
  published(name: string, fetch: RegistryFetch): Promise<{ name: string; versions: PublishedVersion[] }>;
  /** The URL of the archive of `name` at `version`. */
  archiveUrl(name: string, version: string): string;
}
