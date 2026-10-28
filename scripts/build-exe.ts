// Builds a standalone executable: esbuild bundles src/ into one CommonJS file, then
// Node's single-executable support (`node --build-sea`) embeds it in a copy of node.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { build } from 'esbuild';

const outDir = 'dist';
const bundle = `${outDir}/sb-bridge.cjs`;
const exe = `${outDir}/sb-bridge${process.platform === 'win32' ? '.exe' : ''}`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir);

await build({
  entryPoints: ['src/cli.ts'],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node26',
  // ws loads these optional native addons inside try/catch and falls back to JS.
  external: ['bufferutil', 'utf-8-validate'],
});

const seaConfig = `${outDir}/sea-config.json`;
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: exe, disableExperimentalSEAWarning: true, useCodeCache: true }, null, 2),
);
execFileSync(process.execPath, ['--build-sea', seaConfig], { stdio: 'inherit' });
rmSync(seaConfig);
rmSync(bundle);

// Embedding the bundle invalidates node's signature, and Apple Silicon won't run unsigned binaries.
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', '--force', exe], { stdio: 'inherit' });

// What a user needs next to the executable. The integrations' package.json files only exist
// to override this repo's "type": "module" during development.
cpSync('sb-bridge.config.example.json', `${outDir}/sb-bridge.config.example.json`);
cpSync('integrations', `${outDir}/integrations`, {
  recursive: true,
  filter: (src) => basename(src) !== 'package.json',
});

console.log(`built ${exe}`);
