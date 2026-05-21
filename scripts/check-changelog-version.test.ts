import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const realScriptPath = path.resolve(__dirname, 'check-changelog-version.js');

/**
 * Runs the script with synthetic package.json and CHANGELOG.md by mirroring
 * the repo layout in a temp dir: temp/scripts/check-changelog-version.js
 * with temp/package.json and temp/CHANGELOG.md alongside it, so __dirname
 * resolves correctly.
 */
function run(
  pkgVersion: string | null,
  changelogContent: string,
): { exitCode: number; stdout: string; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-check-'));
  try {
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(scriptsDir);
    fs.copyFileSync(realScriptPath, path.join(scriptsDir, 'check-changelog-version.js'));

    const pkg = pkgVersion === null ? {} : { version: pkgVersion };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelogContent);

    try {
      const stdout = execFileSync(
        process.execPath,
        [path.join(scriptsDir, 'check-changelog-version.js')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { exitCode: 0, stdout, stderr: '' };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        exitCode: e.status ?? 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
      };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-changelog-version', () => {
  describe('exit 0 — versions match', () => {
    it('matches a bracketed heading without date', () => {
      const result = run('1.2.3', '## [1.2.3]\n\n- change\n');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1.2.3');
    });

    it('matches a bracketed heading with date', () => {
      const result = run('1.2.3', '## [1.2.3] - 2024-01-15\n\n- change\n');
      expect(result.exitCode).toBe(0);
    });

    it('matches a bracketed heading with trailing annotation', () => {
      const result = run('1.2.3', '## [1.2.3] - 2024-01-15 (hotfix)\n\n- change\n');
      expect(result.exitCode).toBe(0);
    });

    it('skips an Unreleased heading and matches the next real release', () => {
      const changelog = '## [Unreleased]\n\n- wip\n\n## [1.2.3] - 2024-01-01\n\n- done\n';
      const result = run('1.2.3', changelog);
      expect(result.exitCode).toBe(0);
    });

    it('picks the first (most recent) release when multiple headings exist', () => {
      const changelog = '## [2.0.0] - 2025-01-01\n\n## [1.0.0] - 2024-01-01\n';
      const result = run('2.0.0', changelog);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('exit 1 — version mismatch', () => {
    it('exits 1 when package.json version differs from CHANGELOG heading', () => {
      const result = run('1.2.3', '## [1.2.4] - 2024-01-01\n\n- change\n');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('does not match');
    });
  });

  describe('exit 2 — bad input', () => {
    it('exits 2 when package.json has no version field', () => {
      const result = run(null, '## [1.0.0] - 2024-01-01\n');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('missing a `version` field');
    });

    it('exits 2 when CHANGELOG has no matching release heading', () => {
      const result = run('1.0.0', '## [Unreleased]\n\n- wip\n');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('no `## [X.Y.Z]` release heading found');
    });

    it('skips pre-release strings like 1.2.3-beta and treats as no heading found', () => {
      const result = run('1.2.3', '## [1.2.3-beta] - 2024-01-01\n');
      expect(result.exitCode).toBe(2);
    });
  });
});
