#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const manifestPaths = ['packages/core/package.json', 'packages/cli/package.json'].map((manifestPath) =>
  path.resolve(manifestPath)
);

const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const violations = [];

for (const manifestPath of manifestPaths) {
  const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const field of dependencyFields) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') {
      continue;
    }

    for (const [dependencyName, range] of Object.entries(deps)) {
      if (typeof range !== 'string') {
        continue;
      }

      if (range.trim().toLowerCase().startsWith('workspace:')) {
        violations.push(
          `${path.relative(process.cwd(), manifestPath)} -> ${field}.${dependencyName} = ${range}`
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Publish manifest validation failed: workspace: ranges are not allowed.');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Publish manifest validation passed.');
