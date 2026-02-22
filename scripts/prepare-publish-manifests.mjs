#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const manifestPaths = ['packages/core/package.json', 'packages/cli/package.json'].map((manifestPath) =>
  path.resolve(manifestPath)
);

const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];

const manifests = manifestPaths.map((manifestPath) => ({
  manifestPath,
  pkg: JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}));

const packageVersions = new Map(
  manifests
    .filter(({ pkg }) => typeof pkg?.name === 'string' && typeof pkg?.version === 'string')
    .map(({ pkg }) => [pkg.name, pkg.version])
);

const resolveWorkspaceRange = (workspaceRange, version) => {
  const spec = workspaceRange.trim().slice('workspace:'.length).trim();

  if (spec === '' || spec === '*') {
    return version;
  }

  if (spec === '^') {
    return `^${version}`;
  }

  if (spec === '~') {
    return `~${version}`;
  }

  if (/^\d/.test(spec)) {
    return spec;
  }

  throw new Error(`Unsupported workspace dependency range: ${workspaceRange}`);
};

const rewrites = [];

for (const { manifestPath, pkg } of manifests) {
  let changed = false;

  for (const field of dependencyFields) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') {
      continue;
    }

    for (const [dependencyName, range] of Object.entries(deps)) {
      if (typeof range !== 'string') {
        continue;
      }

      if (!range.trim().toLowerCase().startsWith('workspace:')) {
        continue;
      }

      const dependencyVersion = packageVersions.get(dependencyName);
      if (!dependencyVersion) {
        throw new Error(
          `Cannot resolve workspace dependency "${dependencyName}" in ${path.relative(process.cwd(), manifestPath)}`
        );
      }

      const nextRange = resolveWorkspaceRange(range, dependencyVersion);
      if (nextRange === range) {
        continue;
      }

      deps[dependencyName] = nextRange;
      changed = true;
      rewrites.push(
        `${path.relative(process.cwd(), manifestPath)} -> ${field}.${dependencyName}: ${range} => ${nextRange}`
      );
    }
  }

  if (changed) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

if (rewrites.length === 0) {
  console.log('No publish manifest rewrites were needed.');
} else {
  console.log('Prepared publish manifests:');
  for (const rewrite of rewrites) {
    console.log(`- ${rewrite}`);
  }
}
