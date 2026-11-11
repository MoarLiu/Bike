import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildSourceExporter() {
  const directory = path.join(root, 'desktop-mygo/internal/sourceexport/generated');
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir: directory,
      emptyOutDir: true,
      target: 'chrome120',
      sourcemap: false,
      minify: true,
      lib: { entry: path.join(root, 'src/sourceExport.ts'), formats: ['iife'], name: 'BikeSourceExport', fileName: () => 'renderer.js' },
    },
  });
  for (const name of ['main.cjs', 'preload.cjs', 'index.html'])
    await fs.copyFile(path.join(root, 'desktop-mygo/internal/sourceexport/payload', name), path.join(directory, name));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'bike-source-export', version: '1.0.0', main: 'main.cjs' }) + '\n');
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(await buildSourceExporter());
