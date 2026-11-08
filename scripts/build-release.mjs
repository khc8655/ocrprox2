#!/usr/bin/env node
/**
 * scripts/build-release.mjs
 *
 * Multi-architecture release build script for LLMProxy2.
 * Cross-compiles static CGO_ENABLED=0 binaries, embeds assets, and generates SHA256SUMS.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function logStep(msg) {
  console.log(`\n${colors.bold}${colors.cyan}▶ ${msg}${colors.reset}`);
}

function logOk(msg) {
  console.log(`  ${colors.green}✔ ${msg}${colors.reset}`);
}

console.log(`${colors.bold}${colors.cyan}============================================================`);
console.log(`📦 LLMProxy2 Release Build & Cross-Compilation Pipeline`);
console.log(`============================================================${colors.reset}`);

// 1. Read version and commit metadata
logStep('1. Reading version and commit metadata');
const versionPath = join(projectRoot, 'version.json');
if (!existsSync(versionPath)) {
  console.error('version.json not found');
  process.exit(1);
}
const versionInfo = JSON.parse(readFileSync(versionPath, 'utf8'));
const version = versionInfo.version;
const semver = versionInfo.semver;

let commit = 'dev';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();
} catch (_) {}

logOk(`Version: ${version} (semver: ${semver}, commit: ${commit})`);

// 2. Build catalog & admin assets
logStep('2. Compiling shared preset catalog and admin UI');
execFileSync('node', ['shared/presets/build-catalog.mjs'], {
  cwd: projectRoot,
  stdio: 'inherit',
});
logOk('Presets catalog built');

execFileSync('node', ['shared/admin/build.mjs'], {
  cwd: projectRoot,
  stdio: 'inherit',
});
logOk('Admin UI built');

// 3. Sync admin dist to internal/admin/assets/index.html to ensure zero drift
logStep('3. Synchronizing embedded assets');
const sharedDistHtml = join(projectRoot, 'shared/admin/dist/index.html');
const internalAssetHtml = join(projectRoot, 'internal/admin/assets/index.html');
if (existsSync(internalAssetHtml) && existsSync(sharedDistHtml)) {
  const sharedContent = readFileSync(sharedDistHtml);
  const internalContent = readFileSync(internalAssetHtml);
  if (!sharedContent.equals(internalContent)) {
    copyFileSync(sharedDistHtml, internalAssetHtml);
    logOk('Updated internal/admin/assets/index.html from shared/admin/dist/index.html');
  } else {
    logOk('Embedded assets are already identical');
  }
}

// 4. Ensure dist directory exists
const distDir = join(projectRoot, 'dist');
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// 5. Cross-compile static Go binaries
logStep('4. Cross-compiling static Go binaries (CGO_ENABLED=0)');
const ldflags = `-s -w -X main.version=${version} -X main.AppVersion=${semver} -X main.commit=${commit}`;

const targets = [
  { os: 'linux', arch: 'amd64', filename: 'llmproxy-linux-amd64' },
  { os: 'linux', arch: 'arm64', filename: 'llmproxy-linux-arm64' },
  { os: 'darwin', arch: 'arm64', filename: 'llmproxy-darwin-arm64' },
];

const checksums = [];

for (const target of targets) {
  const outputPath = join(distDir, target.filename);
  console.log(`  ${colors.dim}Compiling ${target.filename} (${target.os}/${target.arch})...${colors.reset}`);

  execFileSync(
    'go',
    ['build', '-trimpath', `-ldflags=${ldflags}`, '-o', outputPath, './cmd/llmproxy'],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: target.os,
        GOARCH: target.arch,
      },
      stdio: 'inherit',
    }
  );

  const fileStat = statSync(outputPath);
  const sizeMB = (fileStat.size / (1024 * 1024)).toFixed(2);

  // Compute SHA256
  const fileBytes = readFileSync(outputPath);
  const sha256 = createHash('sha256').update(fileBytes).digest('hex');
  checksums.push(`${sha256}  ${target.filename}`);

  logOk(`Built ${target.filename} (${sizeMB} MB, sha256: ${sha256.slice(0, 12)}...)`);
}

// 6. Write SHA256SUMS
logStep('5. Writing dist/SHA256SUMS');
const checksumsPath = join(distDir, 'SHA256SUMS');
writeFileSync(checksumsPath, checksums.join('\n') + '\n', 'utf8');
logOk(`Saved ${checksumsPath}`);

console.log(`\n${colors.bold}${colors.green}============================================================`);
console.log(`🎉 RELEASE BUILD COMPLETED SUCCESSFULLY!`);
console.log(`   Artifacts generated in dist/:`);
for (const t of targets) {
  console.log(`   - dist/${t.filename}`);
}
console.log(`   - dist/SHA256SUMS`);
console.log(`============================================================${colors.reset}\n`);
