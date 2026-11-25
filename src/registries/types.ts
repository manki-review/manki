/** Downloads a URL of the registry's own hosts whole, with at most `maxBytes`. Throws for any other host. */
export type RegistryFetch = (url: string, maxBytes: number, headers?: Record<string, string>) => Promise<Buffer>;

/** A file of the checkout that can set where packages come from, such as an `.npmrc`. */
export interface RegistryConfig {
  file: string;
  text: string;
}

/** A manifest's requirement for a package, with the package's name as the manifest spells it. */
export interface Requirement {
  name: string;
  requirement: string;
}

/** What a manifest says of one package. */
export interface ManifestFacts {
  requirements: Requirement[];
  /** Set, to how, when the manifest changes the package's code for an install, such as through `overrides` or `[patch]`. */
  overridden?: string;
  /** Set, to how, when the manifest takes the package from somewhere other than the registry, or states it in a way Manki does not read. */
  otherSource?: string;
}

/** One published version of a package, with the checksum the registry states for its archive. */
export interface PublishedVersion {
  version: string;
  checksum: string;
  /** Pulled from the registry, so no new install picks it. */
  yanked?: true;
  /** Marked deprecated, so an install picks it only when no other version matches. */
  deprecated?: true;
  /** The oldest Rust version it says it builds with, as the registry states it, which may be no version at all. */
  rustVersion?: unknown;
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
  /** The file names of lockfiles and install settings Manki does not read, which can decide what an install gets. */
  unreadInstallFiles: readonly string[];
  /** The name of the folders that hold the build output, such as Cargo's `target`, whose files of this registry no install reads. */
  buildFolder?: string;
  /**
   * Returns one of `paths`, the files git tracks inside a committed install such as `node_modules`, when the registry's
   * projects can run such a copy in place of its archives, or `undefined`.
   */
  installedCopy(paths: readonly string[]): string | undefined;
  /** Whether `name` is a valid package name of the registry. No other name reaches a URL. */
  validName(name: string): boolean;
  /** Whether two spellings name the same package, such as `serde_json` and `serde-json` on crates.io. */
  sameName(a: string, b: string): boolean;
  /**
   * Whether a lockfile's source for the package `name` at `version` is this registry's archive of that package, the
   * only source Manki reads a package from.
   */
  isRegistrySource(source: string | undefined, name: string, version: string): boolean;
  /**
   * Whether a lockfile's source names the registry by its host. A source without one, such as Yarn's `npm`, means the
   * registry the project is set up with, which the note on the package says.
   */
  namesHost(source: string | undefined): boolean;
  /**
   * Whether the file at `path`, relative to the repository root, can set where packages come from or change their code
   * for an install, such as an `.npmrc` or a `.cargo/config.toml`.
   */
  isConfigFile(path: string): boolean;
  /**
   * Returns which of `configs` sets another registry than this one for the package `name`, and to what, or `undefined`.
   * This and each other reason passes the PR's own text, such as a path, through `shown`.
   */
  otherRegistry(name: string, configs: readonly RegistryConfig[]): string | undefined;
  /**
   * Returns how one of `configs` changes the code of the package `name` for an install, or `undefined`. Throws when
   * Manki cannot read one of them with certainty.
   */
  overriddenBy(name: string, configs: readonly RegistryConfig[]): string | undefined;
  /**
   * Returns which of `files`, the settings and manifests of the checkout, makes a fresh install pick another version
   * than the highest a requirement allows, and how, or `undefined`. When that depends on the highest version, returns a
   * test that takes it and returns the same. Throws when Manki cannot read one with certainty.
   */
  freshPick(files: readonly RegistryConfig[]): string | ((highest: PublishedVersion) => string | undefined) | undefined;
  /**
   * Returns what a manifest's `text` says of the package `name`: its requirements, in the manifest's own syntax, and
   * whether it overrides the package. Throws when Manki cannot read the manifest with certainty.
   */
  manifest(text: string, name: string): ManifestFacts;
  /** Returns the semver range of a requirement, or `undefined` for one that names no registry version, such as a path or a git source. */
  range(requirement: string): string | undefined;
  /**
   * Returns the package's own name as the registry spells it, and its published versions. `latest` is the version the
   * registry marks as the default to install, which an install picks first when it matches.
   */
  published(name: string, fetch: RegistryFetch): Promise<{ name: string; versions: PublishedVersion[]; latest?: string }>;
  /** The URL of the archive of `name` at `version`. */
  archiveUrl(name: string, version: string): string;
}
