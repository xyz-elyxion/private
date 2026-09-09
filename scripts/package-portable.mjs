#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'),
);
const nodeVersion = (packageJson.engines?.node?.match(/(\d+\.\d+\.\d+)/) ?? [])[1] ?? '20.19.0';
const nodeRelease = `v${nodeVersion}`;

const targets = {
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    nodeArch: 'x64',
    archive: 'tar.xz',
    nodeDir: `node-${nodeRelease}-linux-x64`,
  },
  'linux-arm64': {
    platform: 'linux',
    arch: 'arm64',
    nodeArch: 'arm64',
    archive: 'tar.xz',
    nodeDir: `node-${nodeRelease}-linux-arm64`,
  },
  'macos-x64': {
    platform: 'darwin',
    arch: 'x64',
    nodeArch: 'x64',
    archive: 'tar.gz',
    nodeDir: `node-${nodeRelease}-darwin-x64`,
  },
  'macos-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    nodeArch: 'arm64',
    archive: 'tar.gz',
    nodeDir: `node-${nodeRelease}-darwin-arm64`,
  },
  'windows-x64': {
    platform: 'win32',
    arch: 'x64',
    nodeArch: 'x64',
    archive: 'zip',
    nodeDir: `node-${nodeRelease}-win-x64`,
  },
  'windows-arm64': {
    platform: 'win32',
    arch: 'arm64',
    nodeArch: 'arm64',
    archive: 'zip',
    nodeDir: `node-${nodeRelease}-win-arm64`,
  },
};

const argValue = (name, fallback) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};

const targetName = argValue('target', `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch}`);
const target = targets[targetName];
if (!target) {
  throw new Error(`Unsupported target "${targetName}". Choose one of: ${Object.keys(targets).join(', ')}`);
}
if (target.platform !== process.platform || target.arch !== process.arch) {
  throw new Error(
    `Portable packages must be built on the target platform and architecture. ` +
      `Requested ${targetName}, running on ${process.platform}-${process.arch}. ` +
      `Use the release workflow to build all platforms.`,
  );
}

const outputRoot = path.join(projectRoot, 'release');
const packageName = `instagib-arena-${targetName}`;
const outputDir = path.join(outputRoot, packageName);
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'instagib-runtime-'));
const archiveName = `node-${nodeRelease}-${target.platform === 'win32' ? 'win' : target.platform}-${target.nodeArch}.${target.archive}`;
const archivePath = path.join(tempDir, archiveName);
const runtimeUrl = `https://nodejs.org/dist/${nodeRelease}/${archiveName}`;

const copy = async (source, destination) => {
  await fs.cp(source, destination, { recursive: true, force: true });
};

const downloadRuntime = async () => {
  console.log(`[package] downloading ${runtimeUrl}`);
  const response = await fetch(runtimeUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download Node runtime: ${response.status} ${response.statusText}`);
  }
  const file = await fs.open(archivePath, 'w');
  const hash = crypto.createHash('sha256');
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      await file.write(buffer);
    }
  } finally {
    await file.close();
  }
  console.log(`[package] runtime sha256 ${hash.digest('hex')}`);
};

const extractRuntime = async (runtimeDir) => {
  await fs.mkdir(runtimeDir, { recursive: true });
  execFileSync('tar', ['-xf', archivePath, '-C', tempDir], { stdio: 'inherit' });
  await copy(path.join(tempDir, target.nodeDir), runtimeDir);
};

const writeLaunchers = async () => {
  const posixLauncher = `#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$HERE"
INSTAGIB_PORTABLE=1 exec "$HERE/runtime/bin/node" "$HERE/bin/instagib.mjs" "$@"
`;
  const windowsLauncher = `@echo off
setlocal
cd /d "%~dp0"
set INSTAGIB_PORTABLE=1
"%~dp0runtime\\node.exe" "%~dp0bin\\instagib.mjs" %*
exit /b %errorlevel%
`;
  await fs.writeFile(path.join(outputDir, 'instagib'), posixLauncher, 'utf8');
  await fs.writeFile(path.join(outputDir, 'instagib.cmd'), windowsLauncher, 'utf8');
  await fs.chmod(path.join(outputDir, 'instagib'), 0o755);
};

const writeReadme = async () => {
  const text = `Elyxion portable package (${targetName})

This folder includes its own Node.js runtime. Node.js does not need to be
installed on the target computer.

Run the game server:
  Windows: instagib.cmd start
  macOS/Linux: ./instagib start

Useful commands:
  start       Start the production server
  serve       Build the client and start the server
  lan         Print LAN URLs
  help        Show all commands

The server listens on http://localhost:8787 by default. Runtime data is stored
in ./data. Configure it with the same environment variables described in the
main project README.
`;
  await fs.writeFile(path.join(outputDir, 'README.txt'), text, 'utf8');
};

try {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  await downloadRuntime();

  console.log(`[package] copying application to ${outputDir}`);
  await copy(path.join(projectRoot, 'bin'), path.join(outputDir, 'bin'));
  await copy(path.join(projectRoot, 'server'), path.join(outputDir, 'server'));
  await copy(path.join(projectRoot, 'src', 'game'), path.join(outputDir, 'src', 'game'));
  await copy(path.join(projectRoot, 'scripts', 'ensure-native.mjs'), path.join(outputDir, 'scripts', 'ensure-native.mjs'));
  await copy(path.join(projectRoot, 'scripts', 'lan-url.mjs'), path.join(outputDir, 'scripts', 'lan-url.mjs'));
  await copy(path.join(projectRoot, 'dist'), path.join(outputDir, 'dist'));
  await copy(path.join(projectRoot, 'node_modules'), path.join(outputDir, 'node_modules'));
  await copy(path.join(projectRoot, 'package.json'), path.join(outputDir, 'package.json'));
  await copy(path.join(projectRoot, 'tsconfig.server.json'), path.join(outputDir, 'tsconfig.server.json'));

  await extractRuntime(path.join(outputDir, 'runtime'));
  await writeLaunchers();
  await writeReadme();

  console.log(`[package] ready: ${outputDir}`);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
