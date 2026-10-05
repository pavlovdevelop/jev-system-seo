import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// `npm run build:server` — bundles the server and the page-extraction worker (see src/server/crawl/extract-pool.ts).
// The worker is a separate file because a worker thread starts from a script of its own; the server looks for it next
// to itself. Dependencies stay external (they are installed next to the bundle).

/** `outdir` is relative to the project root, wherever the command is run from. */
export async function buildServer(outdir = 'dist'): Promise<void> {
  await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: { server: 'src/server/index.ts', 'extract-worker': 'src/server/crawl/extract-worker.ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    outdir,
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildServer();
}
