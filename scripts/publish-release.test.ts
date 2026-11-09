import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPTS = ['publish-release.sh', 'check-changelog-version.js'];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

// Answers `gh release view` from FAKE_GH_RELEASE and fails on anything else, so a
// dry run that tried to write the release would fail the test.
const FAKE_GH = `#!/usr/bin/env bash
if [ "$1 $2" = "release view" ]; then
  case "$FAKE_GH_RELEASE" in
    absent) echo "release not found" >&2; exit 1 ;;
    draft) echo true ;;
    published) echo false ;;
  esac
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;

interface Fixture {
  dir: string;
  work: string;
  release: string;
  build: string;
  git: (...args: string[]) => string;
}

function writeRelease(work: string, version: string): void {
  fs.writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({ name: 'fx', version, scripts: { build: 'mkdir -p dist && echo built > dist/index.js' } }),
  );
  fs.writeFileSync(
    path.join(work, 'package-lock.json'),
    JSON.stringify({
      name: 'fx',
      version,
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'fx', version } },
    }),
  );
  fs.writeFileSync(
    path.join(work, 'CHANGELOG.md'),
    `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-11-06\n\n- Notes for ${version}.\n\n## [0.9.0] - 2026-01-01\n\n- Old notes.\n`,
  );
}

/**
 * Builds a repo with an `origin` bare remote: `main` holds a release commit for
 * `version` and `release/v<version>` holds a build commit adding `dist/` on top of it.
 */
function setup(version = '1.2.3', branchVersion = version): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-release-'));
  const work = path.join(dir, 'work');
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: work, env: GIT_ENV, encoding: 'utf8' }).trim();

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(dir, 'remote.git')], { env: GIT_ENV });
  fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', path.join(dir, 'remote.git'));
  for (const script of SCRIPTS) {
    fs.copyFileSync(path.join(__dirname, script), path.join(work, 'scripts', script));
  }
  fs.writeFileSync(path.join(work, '.gitignore'), 'dist/\nnode_modules/\n');
  writeRelease(work, '0.9.0');
  git('add', '.');
  git('commit', '-q', '-m', 'previous release');
  writeRelease(work, version);
  git('add', '.');
  git('commit', '-q', '-m', 'release');
  const release = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', 'main');

  git('checkout', '-q', '--detach');
  fs.mkdirSync(path.join(work, 'dist'));
  fs.writeFileSync(path.join(work, 'dist', 'index.js'), 'built\n');
  git('add', '-f', 'dist/');
  git('commit', '-q', '-m', 'build');
  const build = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', `HEAD:refs/heads/release/v${branchVersion}`);
  git('checkout', '-q', 'main');

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  return { dir, work, release, build, git };
}

function publish(
  fx: Fixture,
  tag: string,
  ghRelease: 'absent' | 'draft' | 'published' = 'absent',
  ...flags: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['scripts/publish-release.sh', '--dry-run', ...flags, tag], {
    cwd: fx.work,
    encoding: 'utf8',
    env: {
      ...GIT_ENV,
      PATH: `${path.join(fx.dir, 'bin')}${path.delimiter}${process.env.PATH}`,
      FAKE_GH_RELEASE: ghRelease,
      WAIT_SECONDS: '0',
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('publish-release.sh --dry-run', () => {
  let fx: Fixture;

  afterEach(() => {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });

  it('prints the tag, release and major tag commands for a new release', () => {
    fx = setup();
    const result = publish(fx, 'v1.2.3');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const commands = result.stdout.split('\n').filter((line) => line.startsWith('dry-run:'));
    expect(commands).toEqual([
      `dry-run: git tag -fa v1.2.3 ${fx.build} -m v1.2.3`,
      'dry-run: git push origin refs/tags/v1.2.3',
      expect.stringMatching(
        /^dry-run: gh release create v1\.2\.3 -R manki-review\/manki --verify-tag --title v1\.2\.3 --notes-file \S+ --latest=true$/,
      ),
      `dry-run: git tag -fa v1 ${fx.build} -m Update\\ v1\\ tag\\ to\\ v1.2.3`,
      'dry-run: git push --force origin refs/tags/v1',
    ]);
    expect(result.stdout).toContain('- Notes for 1.2.3.');
    expect(result.stdout).not.toContain('Old notes');
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe(`verified build commit ${fx.build}`);
  });

  it('skips the rebuild only for the verified build commit', () => {
    fx = setup();
    const verified = publish(fx, 'v1.2.3', 'absent', `--verified=${fx.build}`);
    expect(verified.stderr).toBe('');
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain(`dry-run: git tag -fa v1.2.3 ${fx.build} -m v1.2.3`);
    expect(verified.stdout).not.toContain('rebuilding dist/');
    expect(verified.stdout).not.toContain('verified build commit');

    const moved = publish(fx, 'v1.2.3', 'absent', `--verified=${fx.release}`);
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain(`points at ${fx.build}, not the verified build commit ${fx.release}`);
    expect(moved.stdout).not.toContain('dry-run:');
  });

  it('prints nothing to run once everything is published', () => {
    fx = setup();
    fx.git('tag', '-a', 'v1.2.3', fx.build, '-m', 'v1.2.3');
    fx.git('tag', 'v1', fx.build);
    fx.git('push', '-q', 'origin', 'refs/tags/v1.2.3', 'refs/tags/v1');
    const result = publish(fx, 'v1.2.3', 'published');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('dry-run:');
    expect(result.stdout).toContain('release v1.2.3 is already published');
  });

  it('publishes a draft and leaves the major tag behind a newer release', () => {
    fx = setup();
    fx.git('tag', 'v1.3.0', fx.release);
    fx.git('push', '-q', 'origin', 'refs/tags/v1.3.0');
    const result = publish(fx, 'v1.2.3', 'draft');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry-run: gh release edit v1.2.3 -R manki-review/manki --draft=false --latest=false');
    expect(result.stdout).toContain('v1 stays where it is');
    expect(result.stdout).not.toContain('refs/tags/v1\n');
  });

  it('refuses to move a published tag', () => {
    fx = setup();
    fx.git('tag', 'v1.2.3', fx.release);
    fx.git('push', '-q', 'origin', 'refs/tags/v1.2.3');
    const result = publish(fx, 'v1.2.3', 'published');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`v1.2.3 is published at ${fx.release} and can't move`);
    expect(result.stdout).not.toContain('dry-run:');
  });

  it('refuses a build commit that changes more than dist/', () => {
    fx = setup();
    fx.git('checkout', '-q', fx.build);
    fs.appendFileSync(path.join(fx.work, 'CHANGELOG.md'), 'tampered\n');
    fx.git('commit', '-q', '--amend', '-a', '-m', 'build');
    fx.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/release/v1.2.3');
    const result = publish(fx, 'v1.2.3');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('plus a fresh dist/');
  });

  it('refuses a build whose dist/ differs from a fresh build', () => {
    fx = setup();
    fx.git('checkout', '-q', fx.build);
    fs.writeFileSync(path.join(fx.work, 'dist', 'index.js'), 'planted\n');
    fx.git('commit', '-q', '--amend', '-a', '-m', 'build');
    fx.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/release/v1.2.3');
    const result = publish(fx, 'v1.2.3');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('plus a fresh dist/');
  });

  it('refuses a release commit that is not on main', () => {
    fx = setup();
    fx.git('checkout', '-q', '--orphan', 'other');
    fx.git('commit', '-q', '--allow-empty', '-m', 'other');
    fx.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/main');
    const result = publish(fx, 'v1.2.3');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`release commit ${fx.release} is not on origin/main`);
  });

  it('refuses a later main commit at the same version', () => {
    fx = setup();
    fx.git('commit', '-q', '--allow-empty', '-m', 'feature');
    fx.git('push', '-q', 'origin', 'main');
    const feature = fx.git('rev-parse', 'HEAD');
    fx.git('checkout', '-q', '--detach');
    fs.mkdirSync(path.join(fx.work, 'dist'));
    fs.writeFileSync(path.join(fx.work, 'dist', 'index.js'), 'built\n');
    fx.git('add', '-f', 'dist/');
    fx.git('commit', '-q', '-m', 'build');
    fx.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/release/v1.2.3');
    const result = publish(fx, 'v1.2.3');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`release commit ${feature} doesn't bump the version to 1.2.3`);
  });

  it('refuses a release branch whose name does not match package.json', () => {
    fx = setup('1.2.3', '1.2.4');
    const result = publish(fx, 'v1.2.4');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package.json version 1.2.3 at');
  });

  it('fails fast when the release branch is missing', () => {
    fx = setup();
    const result = publish(fx, 'v2.0.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release/v2.0.0 doesn't exist on origin");
  });

  it('fails when the release branch has no build commit yet', () => {
    fx = setup();
    fx.git('push', '-q', '-f', 'origin', `${fx.release}:refs/heads/release/v1.2.3`);
    const result = publish(fx, 'v1.2.3');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no build commit on release/v1.2.3');
  });
});
