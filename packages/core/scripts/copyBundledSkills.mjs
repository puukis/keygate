import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const sourceDir = path.resolve(packageDir, 'skills');
const destinationDir = path.resolve(packageDir, 'dist', 'bundled-skills');

async function main() {
  const sourceStats = await fs.stat(sourceDir).catch(() => null);
  if (!sourceStats || !sourceStats.isDirectory()) {
    throw new Error(`Bundled skills directory not found at ${sourceDir}`);
  }

  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destinationDir), { recursive: true });
  await fs.cp(sourceDir, destinationDir, { recursive: true });

  console.log(`Copied bundled skills to ${destinationDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
