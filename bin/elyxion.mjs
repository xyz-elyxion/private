#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
);

const help = `Elyxion CLI v${packageJson.version}

Usage:
  elyxion <command> [options]

Commands:
  dev                 Run the app with Vite live reload on one port
  dev:lan             Run the single-port dev server on all interfaces
  dev:server          Alias for dev
  build               Build the production client into dist/
  start               Start the production Node server
  serve               Build the client, then start the production server
  preview             Preview the Vite production build
  lan                 Print URLs for opening the app from another LAN device
  load                Run the netcode load harness
  typecheck           Type-check the client and server
  lint                Run ESLint
  run <file> [...]    Run a TypeScript or JavaScript file through tsx
  watch <file> [...]  Run a TypeScript or JavaScript file through tsx watch
  help                Show this help

Examples:
  elyxion dev
  elyxion serve
  elyxion lan --server
  elyxion load --players 8 --duration 12
  elyxion run scripts/netcode-load.ts --players 2

Options passed after a command are forwarded to the underlying tool.
`;

const binName = (name) => {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return path.join(projectRoot, 'node_modules', '.bin', `${name}${suffix}`);
};

const spawnProcess = (command, args = [], options = {}) => {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
    shell: !isPortable && process.platform === 'win32',
  });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) resolve(130);
      else resolve(code ?? 1);
    });
  });
};

const isPortable = process.env.INSTAGIB_PORTABLE === '1';
const toolScripts = {
  eslint: 'node_modules/eslint/bin/eslint.js',
  tsc: 'node_modules/typescript/bin/tsc',
  tsx: 'node_modules/tsx/dist/cli.mjs',
  vite: 'node_modules/vite/bin/vite.js',
};

const toolInvocation = (name, args = []) => {
  if (isPortable) {
    const script = toolScripts[name];
    if (!script) throw new Error(`No portable entry point configured for ${name}`);
    return { command: process.execPath, args: [path.join(projectRoot, script), ...args] };
  }
  return { command: binName(name), args };
};

const runBin = (name, args = [], options = {}) => {
  const invocation = toolInvocation(name, args);
  return spawnProcess(invocation.command, invocation.args, options);
};

const runNode = (script, args = [], options = {}) =>
  spawnProcess(process.execPath, [path.join(projectRoot, script), ...args], options);

const ensureNative = () => (isPortable ? Promise.resolve(0) : runNode('scripts/ensure-native.mjs'));

const runDev = async (args = [], env = {}) => {
  const nativeCode = await ensureNative();
  return nativeCode === 0
    ? runBin('tsx', ['watch', 'server/index.ts', ...args], { env })
    : nativeCode;
};

const runCommand = async (command, args) => {
  switch (command) {
    case 'dev':
    case 'dev:server':
      return runDev(args);
    case 'dev:lan':
      return runDev(args, { HOST: '0.0.0.0' });
    case 'build':
      return runBin('vite', ['build', ...args]);
    case 'start': {
      const nativeCode = await ensureNative();
      return nativeCode === 0
        ? runBin('tsx', ['server/index.ts', ...args], { env: { NODE_ENV: 'production' } })
        : nativeCode;
    }
    case 'serve': {
      const buildCode = await runBin('vite', ['build', ...args]);
      if (buildCode !== 0) return buildCode;
      const nativeCode = await ensureNative();
      return nativeCode === 0
        ? runBin('tsx', ['server/index.ts'], { env: { NODE_ENV: 'production' } })
        : nativeCode;
    }
    case 'preview':
      return runBin('vite', ['preview', ...args]);
    case 'lan':
      return runNode('scripts/lan-url.mjs', args);
    case 'load':
    case 'netcode:load':
      return runBin('tsx', ['scripts/netcode-load.ts', ...args]);
    case 'typecheck':
      return runBin('tsc', ['-p', 'tsconfig.json', '--noEmit']).then(async (code) =>
        code === 0 ? runBin('tsc', ['-p', 'tsconfig.server.json', '--noEmit']) : code,
      );
    case 'lint':
      return runBin('eslint', ['.', ...args]);
    case 'run':
      if (!args[0]) {
        console.error('Usage: elyxion run <file> [args...]');
        return 2;
      }
      return runBin('tsx', args);
    case 'watch':
      if (!args[0]) {
        console.error('Usage: elyxion watch <file> [args...]');
        return 2;
      }
      return runBin('tsx', ['watch', ...args]);
    case 'help':
      console.log(help);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(help);
      return 2;
  }
};

const rawArgs = process.argv.slice(2);
const first = rawArgs[0];

if (!first || first === '--help' || first === '-h') {
  console.log(help);
  process.exitCode = 0;
} else if (first === '--version' || first === '-v') {
  console.log(packageJson.version);
  process.exitCode = 0;
} else {
  runCommand(first, rawArgs.slice(1))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[elyxion] ${error.message}`);
      process.exitCode = 1;
    });
}
