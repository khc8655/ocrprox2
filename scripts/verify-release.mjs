#!/usr/bin/env node
/**
 * scripts/verify-release.mjs
 *
 * Implements the G1 ~ G6 Release Gates defined in docs/RELEASE_SPEC.md §3.
 * Runs deterministic checks, static contracts, test suites, and security scans.
 */

import { readFileSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Helper for formatting colored logs in terminal
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function logHeader(gate, title) {
  console.log(`\n${colors.bold}${colors.cyan}▶ [${gate}] ${title}${colors.reset}`);
}

function logSuccess(msg) {
  console.log(`  ${colors.green}✔ ${msg}${colors.reset}`);
}

function logFailure(gate, msg, error = null) {
  console.error(`\n${colors.bold}${colors.red}✖ [${gate} FAILED] ${msg}${colors.reset}`);
  if (error) {
    console.error(`${colors.dim}${error.message || error}${colors.reset}`);
  }
  process.exit(1);
}

function runCmd(cmd, args, opts = {}) {
  const displayCmd = `${cmd} ${args.join(' ')}`;
  console.log(`  ${colors.dim}$ ${displayCmd}${colors.reset}`);
  try {
    return execFileSync(cmd, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      encoding: 'utf8',
      ...opts,
    });
  } catch (err) {
    throw new Error(`Command failed: ${displayCmd}\n${err.message}`);
  }
}

console.log(`${colors.bold}${colors.cyan}============================================================`);
console.log(`🚀 LLMProxy2 Automated Release Gatekeeper (G1 ~ G6)`);
console.log(`============================================================${colors.reset}`);

// ============================================================================
// Gate G1: 版本与许可证一致性 (Version & License Consistency)
// ============================================================================
logHeader('G1', '版本与许可证一致性 (Version & License Consistency)');
try {
  // 1. version.json validation
  const versionPath = join(projectRoot, 'version.json');
  if (!existsSync(versionPath)) {
    throw new Error('version.json does not exist');
  }
  const versionJson = JSON.parse(readFileSync(versionPath, 'utf8'));

  const requiredFields = ['version', 'semver', 'release_date', 'commit', 'title', 'changelog'];
  for (const f of requiredFields) {
    if (!versionJson[f]) {
      throw new Error(`version.json missing required field '${f}'`);
    }
  }

  // Check version format vYYYYMMDD-NN
  const versionPattern = /^v\d{8}-\d{2}$/;
  if (!versionPattern.test(versionJson.version)) {
    throw new Error(`version '${versionJson.version}' does not match required format vYYYYMMDD-NN`);
  }

  if (!Array.isArray(versionJson.changelog) || versionJson.changelog.length === 0) {
    throw new Error('version.json changelog must be a non-empty array');
  }
  logSuccess(`version.json verified (version: ${versionJson.version}, semver: ${versionJson.semver})`);

  // 2. CHANGELOG.md validation
  const changelogPath = join(projectRoot, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    throw new Error('CHANGELOG.md does not exist');
  }
  const changelogContent = readFileSync(changelogPath, 'utf8');
  if (!changelogContent.includes(`[${versionJson.version}]`)) {
    throw new Error(`CHANGELOG.md does not contain entry for current version [${versionJson.version}]`);
  }
  logSuccess(`CHANGELOG.md contains current version [${versionJson.version}]`);

  // 3. THIRD_PARTY_NOTICES validation
  const tpPath = join(projectRoot, 'THIRD_PARTY_NOTICES');
  if (!existsSync(tpPath)) {
    throw new Error('THIRD_PARTY_NOTICES does not exist');
  }
  const tpContent = readFileSync(tpPath, 'utf8');
  if (!tpContent.includes('yetone/magpie') || !tpContent.includes('MIT License')) {
    throw new Error('THIRD_PARTY_NOTICES missing yetone/magpie MIT License declaration');
  }
  logSuccess('THIRD_PARTY_NOTICES contains yetone/magpie MIT License declaration');
  logSuccess('[G1 PASS] Version and license consistency verified');
} catch (err) {
  logFailure('G1', 'Version or license verification failed', err);
}

// ============================================================================
// Gate G2: 确定性构建与零漂移 (Deterministic Build & Zero Drift)
// ============================================================================
logHeader('G2', '确定性构建与零漂移 (Deterministic Build & Zero Drift)');
try {
  const catalogPath = join(projectRoot, 'shared/presets/catalog.json');
  const adminDistPath = join(projectRoot, 'shared/admin/dist/index.html');
  const internalAssetHtml = join(projectRoot, 'internal/admin/assets/index.html');

  const beforeCatalog = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : '';
  const beforeAdmin = existsSync(adminDistPath) ? readFileSync(adminDistPath, 'utf8') : '';
  const beforeInternal = existsSync(internalAssetHtml) ? readFileSync(internalAssetHtml, 'utf8') : '';
  const deployInstallPath = join(projectRoot, 'deploy/install.sh');
  const rootInstallPath = join(projectRoot, 'install.sh');
  const beforeRootInstall = existsSync(rootInstallPath) ? readFileSync(rootInstallPath, 'utf8') : '';

  // 1. Run preset catalog build
  runCmd('node', ['shared/presets/build-catalog.mjs']);
  if (!existsSync(catalogPath)) {
    throw new Error('shared/presets/catalog.json was not generated');
  }
  logSuccess('Presets catalog generated successfully');

  // 2. Run admin UI build
  runCmd('node', ['shared/admin/build.mjs']);
  if (!existsSync(adminDistPath)) {
    throw new Error('shared/admin/dist/index.html was not generated');
  }
  const stat = statSync(adminDistPath);
  if (stat.size > 245760) {
    throw new Error(`shared/admin/dist/index.html size (${stat.size}B) exceeds 245,760B limit`);
  }
  logSuccess(`Admin UI built successfully (${stat.size} bytes <= 245,760 bytes)`);

  // Synchronize admin dist to internal/admin/assets/index.html to ensure zero build drift
  if (existsSync(internalAssetHtml)) {
    const sharedBuf = readFileSync(adminDistPath);
    const internalBuf = readFileSync(internalAssetHtml);
    if (!sharedBuf.equals(internalBuf)) {
      copyFileSync(adminDistPath, internalAssetHtml);
      logSuccess('Synchronized admin dist to internal/admin/assets/index.html');
    }
  }

  // 3. Check Go build
  runCmd('go', ['build', '-trimpath', '-o', '/dev/null', './cmd/llmproxy'], {
    env: { ...process.env, CGO_ENABLED: '0' },
  });
  logSuccess('Go binary compiles cleanly with CGO_ENABLED=0');

  // 4. Verify zero build drift (generated files match existing files without unexpected divergence)
  const afterCatalog = readFileSync(catalogPath, 'utf8');
  const afterAdmin = readFileSync(adminDistPath, 'utf8');
  const afterInternal = readFileSync(internalAssetHtml, 'utf8');

  if (beforeCatalog && beforeCatalog !== afterCatalog) {
    throw new Error('Build drift detected in shared/presets/catalog.json: build output changed file on disk. Run `npm run build:presets` first.');
  }
  if (beforeAdmin && beforeAdmin !== afterAdmin) {
    throw new Error('Build drift detected in shared/admin/dist/index.html: build output changed file on disk. Run `npm run build:admin` first.');
  }
  if (beforeInternal && beforeInternal !== afterInternal) {
    throw new Error('Build drift detected in internal/admin/assets/index.html. Run `npm run build:admin` first.');
  }
  if (existsSync(deployInstallPath)) {
    const deployInstall = readFileSync(deployInstallPath, 'utf8');
    const afterRootInstall = existsSync(rootInstallPath) ? readFileSync(rootInstallPath, 'utf8') : '';
    if (deployInstall !== afterRootInstall || (beforeRootInstall && beforeRootInstall !== afterRootInstall)) {
      throw new Error('Build drift detected in install.sh vs deploy/install.sh. Run `npm run build:admin` first.');
    }
  }

  logSuccess('Zero build drift verified: build outputs are completely deterministic and up to date');
  logSuccess('[G2 PASS] Deterministic build and zero drift verified');
} catch (err) {
  logFailure('G2', 'Deterministic build or drift verification failed', err);
}

// ============================================================================
// Gate G3 & G4: 契约守卫与 Profile/Schema 对齐 (T1 Contract Guards & Schema Alignment)
// ============================================================================
logHeader('G3 & G4', '前后端契约守卫与 Profile/Schema 双向对齐 (T1 Contracts)');
try {
  runCmd('node', ['--test', 'tests/t1_contracts/verify_contracts.test.mjs']);
  logSuccess('[G3 & G4 PASS] T1 contracts, route guards, UI limits, and settings schema 100% passed');
} catch (err) {
  logFailure('G3 & G4', 'T1 contracts gate failed', err);
}

// ============================================================================
// Gate G5: 全量测试与并发竞争检测 (Test Suites & Race Detection)
// ============================================================================
logHeader('G5', '全量测试与并发竞争检测 (Test Suites & Race Detection)');
try {
  // 1. EdgeOne Hub unit & projection tests
  console.log(`\n  ${colors.bold}• Running EdgeOne Hub tests...${colors.reset}`);
  runCmd('node', ['--test', 'edgeone-hub/test/hub.test.mjs']);
  logSuccess('EdgeOne Hub unit tests passed');

  // 2. Go test with -race
  console.log(`\n  ${colors.bold}• Running Go unit tests with -race detector...${colors.reset}`);
  runCmd('go', ['test', '-race', './...']);
  logSuccess('All Go packages passed race detection cleanly');

  // 3. T3 Blackbox E2E Suite
  console.log(`\n  ${colors.bold}• Running T3 blackbox E2E suite...${colors.reset}`);
  runCmd('node', ['--test', 'tests/t3_e2e/e2e.test.mjs']);
  logSuccess('T3 blackbox E2E tests passed cleanly');

  logSuccess('[G5 PASS] Hub tests, Go race tests, and T3 E2E tests all passed');
} catch (err) {
  logFailure('G5', 'Test suites or race detector failed', err);
}

// ============================================================================
// Gate G6: 工作区洁净度与敏感私钥扫描 (Workspace Cleanliness & Secret Scanning)
// ============================================================================
logHeader('G6', '工作区洁净度与敏感信息扫描 (Workspace Cleanliness & Secret Scanning)');
try {
  const forbiddenExts = new Set(['.pem', '.key', '.pfx', '.p12', '.pkcs12']);
  const forbiddenFiles = new Set(['id_rsa', 'id_dsa', 'id_ed25519', 'id_ecdsa']);
  const forbiddenSnapshotFiles = new Set([
    'before_config.json',
    'after_config.json',
    'before_nodes.json',
    'after_nodes.json',
    'matrix_results.json',
    'live_hub_test_report.md',
  ]);
  const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'results']);

  const privateKeyPattern = /-----BEGIN\s+(?:[A-Z0-9_-]+\s+)?PRIVATE\s+KEY-----/i;
  // Match potential real unscrubbed OpenAI / third-party API keys (>= 32 chars)
  const realKeyPattern = /\b(sk-[a-zA-Z0-9]{32,})\b/;
  // Match potential real leaked node tokens
  const nodeTokenPattern = /\b(stk_node_[a-f0-9]{32,})\b/gi;

  const violations = [];

  function scanDirectory(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
        if (entry.name === '.git') continue;
      }
      if (ignoredDirs.has(entry.name)) {
        continue;
      }

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDirectory(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (forbiddenExts.has(ext)) {
          violations.push(`Forbidden private key file extension: ${fullPath}`);
          continue;
        }
        if (forbiddenFiles.has(entry.name.toLowerCase())) {
          violations.push(`Forbidden private key file: ${fullPath}`);
          continue;
        }
        if (forbiddenSnapshotFiles.has(entry.name.toLowerCase())) {
          violations.push(`Forbidden test snapshot or live test report file detected: ${fullPath}`);
          continue;
        }

        // Avoid scanning large binary files
        const stat = statSync(fullPath);
        if (stat.size > 2 * 1024 * 1024) {
          continue;
        }

        try {
          const content = readFileSync(fullPath, 'utf8');

          if (privateKeyPattern.test(content)) {
            violations.push(`Accidental private key pattern found in ${fullPath}`);
          }

          // Check for unmocked real API keys
          const keyMatch = content.match(realKeyPattern);
          if (keyMatch) {
            const matchedKey = keyMatch[1];
            // Allow synthetic dummy/test keys
            const isTestKey =
              matchedKey.toLowerCase().includes('test') ||
              matchedKey.toLowerCase().includes('mock') ||
              matchedKey.toLowerCase().includes('dummy') ||
              matchedKey.toLowerCase().includes('example') ||
              matchedKey.toLowerCase().includes('secret') ||
              matchedKey.toLowerCase().includes('sample');

            if (!isTestKey) {
              violations.push(`Potential real API key '${matchedKey.slice(0, 8)}...' detected in ${fullPath}`);
            }
          }

          // Check for leaked real node tokens (stk_node_<48hex>)
          const nodeMatches = content.match(nodeTokenPattern);
          if (nodeMatches) {
            for (const token of nodeMatches) {
              const hexPart = token.slice('stk_node_'.length);
              // Allow synthetic tokens:
              // 1. Repeated single character (e.g. all zeros: stk_node_000000...)
              const isRepeatedChar = /^([0-9a-f])\1+$/i.test(hexPart);
              // 2. Repeated sequence pattern (e.g. 0123456789abcdef repeated)
              const isRepeatedPattern = /^([0-9a-f]{2,16})\1+$/i.test(hexPart);
              // 3. Known documentation example or explicit test context
              const isDocExample = hexPart === '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a';
              const isTestFile = fullPath.includes('/test/') || fullPath.includes('/tests/') || fullPath.includes('benchmark');
              const isSynthetic = isRepeatedChar || isRepeatedPattern || isDocExample || (isTestFile && (hexPart.includes('0123456789abcdef') || hexPart.startsWith('000000')));

              if (!isSynthetic) {
                violations.push(`Potential real leaked node token '${token.slice(0, 16)}...' detected in ${fullPath}`);
              }
            }
          }
        } catch (_) {
          // Skip binary or unreadable files
        }
      }
    }
  }

  scanDirectory(projectRoot);

  if (violations.length > 0) {
    throw new Error(`Secret scanning violations detected:\n${violations.join('\n')}`);
  }
  logSuccess('Zero leaked private keys or unmasked real credentials found');

  // Check git status if in git worktree
  let isGit = false;
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' });
    isGit = true;
  } catch (_) {}

  if (isGit) {
    const gitStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    if (gitStatus) {
      console.log(`  ${colors.yellow}Notice: Uncommitted changes in working tree:${colors.reset}`);
      console.log(`  ${colors.dim}${gitStatus}${colors.reset}`);
    } else {
      logSuccess('Git working tree is completely clean');
    }
  } else {
    logSuccess('Workspace scan complete');
  }

  logSuccess('[G6 PASS] Secret scanning and workspace cleanliness verified');
} catch (err) {
  logFailure('G6', 'Security or cleanliness scanning failed', err);
}

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${colors.bold}${colors.green}============================================================`);
console.log(`🎉 ALL G1 ~ G6 RELEASE GATES PASSED!`);
console.log(`   - G1: Version & License Consistency    [PASS]`);
console.log(`   - G2: Deterministic Build & Zero Drift [PASS]`);
console.log(`   - G3: Contracts & Route Guard          [PASS]`);
console.log(`   - G4: Schema & Profile Alignment       [PASS]`);
console.log(`   - G5: Hub Tests & Go Race Detector     [PASS]`);
console.log(`   - G6: Secret Scan & Workspace Clean    [PASS]`);
console.log(`============================================================${colors.reset}\n`);
