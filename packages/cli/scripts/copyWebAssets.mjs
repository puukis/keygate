import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const sourceDir = path.resolve(packageDir, '..', 'web', 'dist');
const destinationDir = path.resolve(packageDir, 'dist', 'web');

async function main() {
  const sourceStats = await fs.stat(sourceDir).catch(() => null);
  if (!sourceStats || !sourceStats.isDirectory()) {
    throw new Error(`Web build output not found at ${sourceDir}. Run @keygate/web build first.`);
  }

  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destinationDir), { recursive: true });
  await fs.cp(sourceDir, destinationDir, { recursive: true });

  console.log(`Copied web assets to ${destinationDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
