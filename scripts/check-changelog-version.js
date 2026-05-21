#!/usr/bin/env node
/*
 * Fails if `package.json` `version` does not match the most recent
 * non-`Unreleased` `## [X.Y.Z]` heading in `CHANGELOG.md`. Guards against
 * shipping a release tag without bumping `package.json` (the v5.0.0 / v5.0.1
 * drift that motivated this check).
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const pkgVersion = pkg.version;
if (typeof pkgVersion !== 'string' || pkgVersion.length === 0) {
  console.error('error: `package.json` is missing a `version` field');
  process.exit(2);
}

const changelog = fs.readFileSync(changelogPath, 'utf8');

// Accept `## [X.Y.Z]`, `## [X.Y.Z] - YYYY-MM-DD`, or defensively `## X.Y.Z`.
// Skip the `Unreleased` placeholder so the check tracks the latest real release.
const headingRe = /^##\s+\[?([^\]\s]+)\]?(?:\s*-\s*\S+)?\s*$/gm;
let changelogVersion = null;
let match;
while ((match = headingRe.exec(changelog)) !== null) {
  const candidate = match[1];
  if (candidate.toLowerCase() === 'unreleased') continue;
  if (!/^\d+\.\d+\.\d+/.test(candidate)) continue;
  changelogVersion = candidate;
  break;
}

if (changelogVersion === null) {
  console.error('error: no `## [X.Y.Z]` release heading found in `CHANGELOG.md`');
  process.exit(2);
}

if (pkgVersion !== changelogVersion) {
  console.error(
    `error: \`package.json\` version (${pkgVersion}) does not match the most recent ` +
      `\`CHANGELOG.md\` release heading (${changelogVersion}).\n` +
      'When adding a new `## [X.Y.Z]` heading, bump `package.json` and `package-lock.json` in the same commit. ' +
      'See RELEASE.md.',
  );
  process.exit(1);
}

console.log(`ok: package.json and CHANGELOG.md agree on version ${pkgVersion}`);
