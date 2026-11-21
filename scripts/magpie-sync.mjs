#!/usr/bin/env node
/**
 * scripts/magpie-sync.mjs
 *
 * Tracks the code this repository vendored from yetone/magpie — which is a
 * moving target: upstream ships hundreds of releases a week. The mapping and
 * the pinned baseline live in docs/magpie-baseline.json; the reasoning and the
 * manual procedure live in docs/MAGPIE_UPSTREAM_SYNC.md.
 *
 *   node scripts/magpie-sync.mjs check        # what did upstream change since the baseline?
 *   node scripts/magpie-sync.mjs apply        # copy the verbatim set from upstream into ours
 *   node scripts/magpie-sync.mjs rebaseline   # pin the current verbatim set as the new baseline
 *   node scripts/magpie-sync.mjs baseline     # show what is pinned right now
 *
 * Flags: --ref <sha|branch|tag> (default: upstream HEAD), --cache <dir>,
 *        --force (apply over locally edited files), --json (machine output).
 *
 * `check` exits 1 when the verbatim set drifted from the baseline or upstream
 * moved under it — that is a real signal, not a build failure. It is deliberately
 * not wired into verify:release.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const baselinePath = join(projectRoot, 'docs', 'magpie-baseline.json');

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function header(title) {
  console.log(`\n${colors.bold}${colors.cyan}▶ ${title}${colors.reset}`);
}

function parseArgs(argv) {
  const args = { command: 'check', ref: '', cache: join(homedir(), '.cache', 'llmproxy2', 'magpie.git'), force: false, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref') args.ref = argv[++i] || '';
    else if (a === '--cache') args.cache = argv[++i] || args.cache;
    else if (a === '--force') args.force = true;
    else if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') args.command = 'help';
    else rest.push(a);
  }
  if (rest.length) args.command = rest[0];
  return args;
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function gitBuffer(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function rewriteModule(text, baseline) {
  return text.split(baseline.upstream_module).join(baseline.our_module);
}

/** Bare partial clone: full commit history, no blobs until a path is asked for (~22 MiB). */
function ensureCache(baseline, cache) {
  if (!existsSync(join(cache, 'HEAD'))) {
    header(`首次准备上游镜像 ${cache}`);
    mkdirSync(dirname(cache), { recursive: true });
    git(projectRoot, ['clone', '--bare', '--filter=blob:none', baseline.upstream_repo, cache]);
  } else {
    git(cache, ['fetch', '--quiet', 'origin', '+refs/heads/*:refs/heads/*', '--tags']);
  }
  return cache;
}

function resolveRef(cache, ref) {
  if (!ref) return git(cache, ['rev-parse', 'HEAD']).trim();
  // A branch or tag name that already exists locally wins; otherwise ask the remote.
  try {
    return git(cache, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    git(cache, ['fetch', '--quiet', 'origin', ref]);
    return git(cache, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).trim();
  }
}

function upstreamFile(cache, commit, path) {
  return gitBuffer(cache, ['show', `${commit}:${path}`]);
}

function upstreamBlob(cache, commit, path) {
  try {
    return git(cache, ['rev-parse', `${commit}:${path}`]).trim();
  } catch {
    return '';
  }
}

function commitList(cache, from, to, paths) {
  if (!from) return [];
  try {
    const out = git(cache, ['log', '--format=%h %ci %s', `${from}..${to}`, '--', ...paths]);
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function reloadBaseline() {
  return JSON.parse(readFileSync(baselinePath, 'utf8'));
}

function localHash(rel) {
  const p = join(projectRoot, rel);
  if (!existsSync(p)) return '';
  return sha256(readFileSync(p));
}

const baseline = reloadBaseline();

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
function cmdCheck(args) {
  const cache = ensureCache(baseline, args.cache);
  const ref = resolveRef(cache, args.ref);
  const refRelease = (() => {
    try {
      return git(cache, ['describe', '--tags', '--always', ref]).trim();
    } catch {
      return ref.slice(0, 8);
    }
  })();

  header('基线');
  console.log(`  上游 ${baseline.upstream_repo}`);
  console.log(`  基线 ${baseline.reference_commit.slice(0, 8)} (${baseline.reference_release}, 核对于 ${baseline.verified_at})`);
  console.log(`  目标 ${ref.slice(0, 8)} (${refRelease})`);

  const report = { ref, refRelease, verbatim: [], adapted: [], semantic: [], baseline: baseline.reference_commit };
  let drift = 0;

  header('A 类 · 逐字节搬运（应完全一致）');
  for (const f of baseline.verbatim) {
    const up = upstreamFile(cache, ref, f.upstream);
    const want = f.rewrite_module ? Buffer.from(rewriteModule(up.toString('utf8'), baseline)) : up;
    const got = existsSync(join(projectRoot, f.ours)) ? readFileSync(join(projectRoot, f.ours)) : Buffer.alloc(0);
    const localEdited = f.sha256 && localHash(f.ours) !== f.sha256;
    const same = got.length === want.length && sha256(got) === sha256(want);
    const failed = !same || localEdited;
    if (failed) drift++;
    const state = same ? `${colors.green}一致${colors.reset}` : `${colors.red}不一致${colors.reset}`;
    const note = localEdited ? `${colors.yellow} 本地已改(基线哈希不符)${colors.reset}` : '';
    console.log(`  ${failed ? '✖' : '✔'} ${f.ours.padEnd(44)} ${state}${note}`);
    if (!same) {
      const upLines = want.toString('utf8').split('\n').length;
      const ourLines = got.toString('utf8').split('\n').length;
      console.log(`      ${colors.dim}上游 ${upLines} 行 / 本地 ${ourLines} 行${colors.reset}`);
    }
    report.verbatim.push({ file: f.ours, same, localEdited });
  }
  for (const f of baseline.verbatim_manual) {
    const localEdited = f.sha256 && localHash(f.ours) !== f.sha256;
    console.log(`  ${localEdited ? '!' : '·'} ${f.ours.padEnd(44)} ${colors.dim}手工维护（${f.note}）${colors.reset}`);
    report.verbatim.push({ file: f.ours, manual: true, localEdited: Boolean(localEdited) });
  }

  header('上游自基线以来动过我们的哪些文件');
  const verbatimPaths = [...new Set([...baseline.verbatim, ...baseline.verbatim_manual].map((f) => f.upstream))];
  const verbatimCommits = commitList(cache, baseline.reference_commit, ref, verbatimPaths);
  if (verbatimCommits.length === 0) {
    console.log(`  ${colors.green}✔ A 类文件上游零改动${colors.reset} —— 无需同步`);
  } else {
    console.log(`  ${colors.yellow}✖ A 类文件上游有 ${verbatimCommits.length} 次改动 —— 需要 apply${colors.reset}`);
    verbatimCommits.forEach((c) => console.log(`      ${colors.dim}${c}${colors.reset}`));
    drift++;
  }
  report.verbatimCommits = verbatimCommits;

  header('B 类 · 搬运后本地改造（上游 diff 需人工判断是否合并）');
  for (const f of baseline.adapted) {
    const commits = commitList(cache, baseline.reference_commit, ref, f.upstream);
    console.log(`  ${commits.length ? '◆' : '·'} ${f.ours}  ${colors.dim}<- ${f.upstream.join(', ')}${colors.reset}`);
    if (commits.length) commits.forEach((c) => console.log(`      ${colors.yellow}${c}${colors.reset}`));
    report.adapted.push({ file: f.ours, upstream: f.upstream, commits });
  }

  header('C 类 · 仅对齐语义（读上游提交，改我们自己的实现；禁止整文件拷贝）');
  for (const f of baseline.semantic) {
    const commits = commitList(cache, baseline.reference_commit, ref, f.upstream);
    console.log(`  ${commits.length ? '◆' : '·'} ${f.ours}  ${colors.dim}<- ${f.upstream.join(', ')}${colors.reset}`);
    if (commits.length) commits.slice(0, 8).forEach((c) => console.log(`      ${c}`));
    if (commits.length > 8) console.log(`      ${colors.dim}… 共 ${commits.length} 次${colors.reset}`);
    report.semantic.push({ file: f.ours, upstream: f.upstream, commits });
  }

  header('结论');
  if (drift === 0) {
    console.log(`  ${colors.green}本仓与基线一致，且上游未改 A 类文件。${colors.reset}`);
  } else {
    console.log(`  ${colors.red}有 ${drift} 项需要处理${colors.reset}：`);
    console.log('    · A 类不一致/上游有改动 → node scripts/magpie-sync.mjs apply，然后 go test');
    console.log('    · B 类有上游提交        → 按 docs/MAGPIE_UPSTREAM_SYNC.md §4.3 三路合并');
    console.log('    · C 类有上游提交        → 读提交说明，判断是否需要改我们自己的实现');
  }

  if (args.json) console.log(JSON.stringify(report, null, 2));
  process.exitCode = drift === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// apply — only the verbatim set, and only when our copy is untouched since baseline
// ---------------------------------------------------------------------------
function cmdApply(args) {
  const cache = ensureCache(baseline, args.cache);
  const ref = resolveRef(cache, args.ref);
  header(`同步 A 类到 ${ref.slice(0, 8)}`);

  let written = 0;
  const skipped = [];
  for (const f of baseline.verbatim) {
    const up = upstreamFile(cache, ref, f.upstream);
    const want = f.rewrite_module ? Buffer.from(rewriteModule(up.toString('utf8'), baseline)) : up;
    const target = join(projectRoot, f.ours);
    const localEdited = f.sha256 && localHash(f.ours) !== f.sha256;
    if (localEdited && !args.force) {
      console.log(`  ${colors.yellow}! ${f.ours} 本地有改动，跳过（确认可覆盖后加 --force）${colors.reset}`);
      skipped.push(f.ours);
      continue;
    }
    if (existsSync(target) && readFileSync(target).equals(want)) {
      console.log(`  ${colors.dim}· ${f.ours} 已是目标版本${colors.reset}`);
      continue;
    }
    writeFileSync(target, want);
    console.log(`  ${colors.green}✔ ${f.ours}${colors.reset}`);
    written++;
  }

  header('下一步');
  console.log(`  写入 ${written} 个文件${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`);
  console.log('  go test ./internal/steady/ ./internal/lastgood/ ./internal/filelock/');
  console.log('  node scripts/magpie-sync.mjs rebaseline --ref ' + ref.slice(0, 12));
  process.exitCode = skipped.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// rebaseline — pin what we now have
// ---------------------------------------------------------------------------
function cmdRebaseline(args) {
  const cache = ensureCache(baseline, args.cache);
  const ref = resolveRef(cache, args.ref || 'HEAD');
  const next = { ...baseline };
  next.reference_commit = ref;
  next.verified_at = new Date().toISOString().slice(0, 10);
  try {
    next.reference_release = git(cache, ['describe', '--tags', '--always', ref]).trim();
  } catch {
    next.reference_release = ref.slice(0, 8);
  }
  for (const f of [...next.verbatim, ...next.verbatim_manual]) {
    const h = localHash(f.ours);
    if (!h) throw new Error(`缺少文件 ${f.ours}`);
    f.sha256 = h;
  }
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  header('基线已更新');
  console.log(`  ${next.reference_commit.slice(0, 8)} (${next.reference_release}) @ ${next.verified_at}`);
  console.log(`  写入 ${baselinePath}`);
  console.log('  记得把 docs/MAGPIE_UPSTREAM_SYNC.md §2.1 的基线与日期一起改掉。');
}

function cmdBaseline() {
  header('当前钉住的上游基线');
  console.log(`  commit  ${baseline.reference_commit}`);
  console.log(`  release ${baseline.reference_release} (${baseline.reference_date})`);
  console.log(`  搬运于  ${baseline.vendored_at}，最后一次核对 ${baseline.verified_at}`);
  console.log(`  A 类 ${baseline.verbatim.length} 个文件 + ${baseline.verbatim_manual.length} 个手工维护`);
  console.log(`  B 类 ${baseline.adapted.length} 个，C 类 ${baseline.semantic.length} 个（见 docs/MAGPIE_UPSTREAM_SYNC.md）`);
}

function cmdHelp() {
  console.log(`用法: node scripts/magpie-sync.mjs <check|apply|rebaseline|baseline> [--ref <sha|tag>] [--force] [--json]

  check       上游自基线以来的改动 + A 类文件是否仍逐字节一致（默认命令）
  apply       把 A 类文件从上游覆盖到本仓（本地改过的会跳过）
  rebaseline  把当前 A 类文件哈希钉成新基线
  baseline    打印当前基线

详见 docs/MAGPIE_UPSTREAM_SYNC.md`);
}

const args = parseArgs(process.argv.slice(2));
switch (args.command) {
  case 'check':
    cmdCheck(args);
    break;
  case 'apply':
    cmdApply(args);
    break;
  case 'rebaseline':
    cmdRebaseline(args);
    break;
  case 'baseline':
    cmdBaseline();
    break;
  default:
    cmdHelp();
    process.exitCode = 2;
}
