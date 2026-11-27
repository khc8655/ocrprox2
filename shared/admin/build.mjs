#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminDir = __dirname;
const distDir = join(adminDir, 'dist');
const projectRoot = join(adminDir, '..', '..');

console.log('=== LLMProxy2 Magpie Minimalist Admin UI Builder & Gate Verification ===\n');

// 1. Gate 5: Node.js syntax check (node --check)
console.log('1. Checking JS syntax (node --check)...');
const jsFiles = ['js/icons.js', 'js/usage.js', 'js/host.js', 'js/app.js'];
for (const file of jsFiles) {
  const fullPath = join(adminDir, file);
  try {
    execFileSync('node', ['--check', fullPath], { stdio: 'inherit' });
    console.log(`   ✓ ${file} syntax OK`);
  } catch (e) {
    console.error(`   ✗ Syntax error in ${file}`);
    process.exit(1);
  }
}

// 2. Read source assets
const htmlPath = join(adminDir, 'admin.html');
const cssPath = join(adminDir, 'css/app.css');
const iconsJsPath = join(adminDir, 'js/icons.js');
const usageJsPath = join(adminDir, 'js/usage.js');
const hostJsPath = join(adminDir, 'js/host.js');
const appJsPath = join(adminDir, 'js/app.js');

let html = readFileSync(htmlPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const iconsJs = readFileSync(iconsJsPath, 'utf8');
const usageJs = readFileSync(usageJsPath, 'utf8');
const hostJs = readFileSync(hostJsPath, 'utf8');
const appJs = readFileSync(appJsPath, 'utf8');

// 3. Gate 1: Zero inline style check (Zero Inline Style Gate)
console.log('\n2. Verifying Gate 1: Zero inline styles (style= / .style.)...');
const styleAttrMatch = html.match(/style\s*=/i) ||
  iconsJs.match(/style\s*=/i) ||
  usageJs.match(/style\s*=/i) ||
  appJs.match(/style\s*=/i) ||
  hostJs.match(/style\s*=/i);
if (styleAttrMatch) {
  console.error(`   ✗ FAILED: Found inline style attribute in sources!`);
  process.exit(1);
}
const stylePropMatch = appJs.match(/\.style\.[a-zA-Z]+/i) ||
  hostJs.match(/\.style\.[a-zA-Z]+/i) ||
  iconsJs.match(/\.style\.[a-zA-Z]+/i) ||
  usageJs.match(/\.style\.[a-zA-Z]+/i);
if (stylePropMatch) {
  console.error(`   ✗ FAILED: Found .style.xxx property manipulation in JS! Use el.hidden instead.`);
  process.exit(1);
}
console.log('   ✓ Zero inline styles verified (100% compliant)');

// 4. Gate 2: Zero drawer check (No Drawer Gate)
console.log('\n3. Verifying Gate 2: Zero drawer components (.drawer)...');
const drawerMatch = html.match(/class\s*=\s*["'][^"']*\bdrawer\b/i) ||
  css.match(/\.drawer\b/i) ||
  appJs.match(/\bdrawer\b/i) ||
  iconsJs.match(/\bdrawer\b/i) ||
  usageJs.match(/\bdrawer\b/i);
if (drawerMatch) {
  console.error('   ✗ FAILED: Found .drawer component in UI sources!');
  process.exit(1);
}
console.log('   ✓ Zero drawers verified (100% compliant)');

// 5. Gate 3: Zero left-border stripes check (No Left-Border Stripes Gate)
console.log('\n4. Verifying Gate 3: Zero left-border color stripes...');
const leftBorderMatch = css.match(/border-left\s*:\s*[^;]*(#|rgb|hsl|var\(--)/i);
if (leftBorderMatch) {
  console.error('   ✗ FAILED: Found left-border color stripe in CSS! Use 7px .dot semantic dots instead.');
  process.exit(1);
}
console.log('   ✓ Zero left-border stripes verified (100% compliant)');

// 6. Inlining into single bundle
console.log('\n5. Inlining CSS & JS into standalone bundle...');
const minCss = css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/\s*([{}:;,])\s*/g, '$1')
  .replace(/;}/g, '}')
  .trim();
function cleanJs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n')
    .replace(/>\n+</g, '><');
}
const cleanIconsJs = cleanJs(iconsJs)
  .replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')
  .replace(/<title>[^<]*<\/title>/g, '')
  .replace(/\\"/g, "'");
const cleanUsageJs = cleanJs(usageJs);
const cleanHostJs = cleanJs(hostJs);
const cleanAppJs = cleanJs(appJs);
let bundledHtml = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/>\s+</g, '><')
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)
  .join('\n');
bundledHtml = bundledHtml.replace('<link rel="stylesheet" href="css/app.css">', () => `<style>\n${minCss}\n</style>`);
bundledHtml = bundledHtml.replace('<script src="js/icons.js"></script>', () => `<script>\n${cleanIconsJs}\n</script>`);
bundledHtml = bundledHtml.replace('<script src="js/usage.js"></script>', () => `<script>\n${cleanUsageJs}\n</script>`);
bundledHtml = bundledHtml.replace('<script src="js/host.js"></script>', () => `<script>\n${cleanHostJs}\n</script>`);
bundledHtml = bundledHtml.replace('<script src="js/app.js"></script>', () => `<script>\n${cleanAppJs}\n</script>`);

mkdirSync(distDir, { recursive: true });
const distPath = join(distDir, 'index.html');
writeFileSync(distPath, bundledHtml, 'utf8');

const internalAssetHtml = join(projectRoot, 'internal/admin/assets/index.html');
if (existsSync(dirname(internalAssetHtml))) {
  writeFileSync(internalAssetHtml, bundledHtml, 'utf8');
}

// 7. Gate 4: Bundle size <= 393,216 bytes (384 KiB)
console.log('\n6. Verifying Gate 4: Bundle size (<= 393,216 bytes)...');
const stat = statSync(distPath);
const sizeKb = (stat.size / 1024).toFixed(2);
console.log(`   Bundle size: ${stat.size} bytes (${sizeKb} KB)`);

if (stat.size > 393216) {
  console.error(`   ✗ FAILED: Bundle size ${stat.size} bytes (${sizeKb} KB) exceeds 393,216 bytes limit!`);
  process.exit(1);
}
console.log(`   ✓ Bundle size ${stat.size} bytes (${sizeKb} KB) <= 393,216 bytes limit (100% compliant)`);

// 8. Generate static admin/index.html (EdgeOne Pages Static CDN Console)
console.log('\n7. Generating static admin/index.html (EdgeOne Hub Console)...');
const edgeFuncDir = join(projectRoot, 'edge-functions');
mkdirSync(edgeFuncDir, { recursive: true });

const hubHtml = bundledHtml
  .replace('<head>', '<head>\n  <script>window.__HOST_KIND__="hub";</script>')
  .replace(`<script>\n${cleanUsageJs}\n</script>`, '')
  .replace(/<div id="fullOverviewBox" hidden>[\s\S]*?<\/section>/, '</section>');

const staticAdminDir = join(projectRoot, 'admin');
mkdirSync(staticAdminDir, { recursive: true });
const staticAdminPath = join(staticAdminDir, 'index.html');
writeFileSync(staticAdminPath, hubHtml, 'utf8');
console.log(`   ✓ admin/index.html generated successfully (${hubHtml.length} bytes, served via static CDN)`);

const legacyEdgeAdminPath = join(edgeFuncDir, 'admin.js');
if (existsSync(legacyEdgeAdminPath)) {
  unlinkSync(legacyEdgeAdminPath);
  console.log('   ✓ Removed legacy edge-functions/admin.js (0 bytes in bu_script)');
}

// Mirror deploy/install.sh to repo root /install.sh so EdgeOne Hub hosts it directly on the same origin.
const deployInstallPath = join(projectRoot, 'deploy/install.sh');
const rootInstallPath = join(projectRoot, 'install.sh');
if (existsSync(deployInstallPath)) {
  writeFileSync(rootInstallPath, readFileSync(deployInstallPath), { mode: 0o755 });
  console.log('   ✓ Synchronized deploy/install.sh -> install.sh (Hub same-origin one-click script)');
}

// 9. Sync pure Web Standard hub files to edge-functions/_hub/ (Self-Contained Edge Packaging)
console.log('\n8. Synchronizing edgeone-hub to edge-functions/_hub/ (Self-Contained Edge Functions)...');
const hubDir = join(projectRoot, 'edgeone-hub');
const generatedPresetsPath = join(hubDir, 'lib/generated-presets.js');
if (!existsSync(generatedPresetsPath)) {
  console.log('   Generating presets catalog & pre-compiled presets map first...');
  execFileSync('node', [join(projectRoot, 'shared/presets/build-catalog.mjs')], { stdio: 'inherit' });
}

// The Hub's per-model capability lookup needs the preset->models.dev provider map
// and the manual overrides, both of which Go embeds. The edge bundle cannot read
// files, so they are frozen into a JS module. Regenerated here whenever the
// sources moved: a stale copy would silently answer different ladder/toogle
// questions on the Hub than on a Full node.
const hubModelMapPath = join(hubDir, 'lib/generated-model-map.js');
const modelMapSources = ['provider-map.json', 'overrides.json'].map((f) => join(projectRoot, 'shared/model-catalog', f));
const modelMapStale = !existsSync(hubModelMapPath) ||
  modelMapSources.some((src) => existsSync(src) && statSync(src).mtimeMs > statSync(hubModelMapPath).mtimeMs);
if (modelMapStale) {
  console.log('   Regenerating edgeone-hub/lib/generated-model-map.js from shared/model-catalog/...');
  execFileSync('node', [join(projectRoot, 'scripts/model-catalog/build-hub-map.mjs')], { stdio: 'inherit' });
}

function syncDirectory(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      syncDirectory(srcPath, destPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      const content = readFileSync(srcPath, 'utf8');
      writeFileSync(destPath, entry.name === 'generated-presets.js' ? content : cleanJs(content), 'utf8');
    }
  }
}

const edgeHubDir = join(edgeFuncDir, '_hub');
syncDirectory(join(hubDir, 'lib'), join(edgeHubDir, 'lib'));
syncDirectory(join(hubDir, 'api'), join(edgeHubDir, 'api'));
console.log('   ✓ edge-functions/_hub/ synchronized successfully');

// 10. Generate edge-functions/api/ route entry points with explicit handler exports
console.log('\n9. Generating edge-functions/api/ route entry points with explicit handler exports...');
const apiRoutes = [
  { file: 'api/config.js', target: '../_hub/api/config.js' },
  { file: 'api/node/config.js', target: '../../_hub/api/node/config.js' },
  { file: 'api/node/heartbeat.js', target: '../../_hub/api/node/heartbeat.js' },
  { file: 'api/admin/nodes.js', target: '../../_hub/api/admin/nodes.js' },
  { file: 'api/admin/nodes/[id].js', target: '../../../_hub/api/admin/nodes.js' },
  { file: 'api/admin/nodes/[id]/rotate.js', target: '../../../../_hub/api/admin/nodes.js' },
  { file: 'api/admin/nodes/[[default]].js', target: '../../../_hub/api/admin/nodes.js' },
  { file: 'api/admin/verify-key.js', target: '../../_hub/api/admin/verify-key.js' },
  { file: 'api/admin/test-key.js', target: '../../_hub/api/admin/test-key.js' },
  // Model catalog admin API (edgeone-hub/api/admin/model-catalog.js).
  // Base path serves GET meta; /update, /data and /lookup are a second path
  // segment, so they need their own dynamic entry file — the same split nodes.js
  // uses for /nodes/:id. The guard below is per *file*, so one entry per handler
  // module is enough; this second entry is what routes the sub-paths.
  { file: 'api/admin/model-catalog.js', target: '../../_hub/api/admin/model-catalog.js' },
  { file: 'api/admin/model-catalog/[action].js', target: '../../../_hub/api/admin/model-catalog.js' },
  { file: 'api/admin/probe-models.js', target: '../../_hub/api/admin/probe-models.js' },
  { file: 'api/vault/manifest.js', target: '../../_hub/api/vault/manifest.js' },
  { file: 'api/vault/fetch.js', target: '../../_hub/api/vault/fetch.js' },
  { file: 'api/admin/fetch-probe.js', target: '../../_hub/api/admin/fetch-probe.js' },
];

// Guard: every handler module in edgeone-hub/api/ must have a route entry above.
// The table is hand-maintained, and a missing entry is invisible at build time —
// the endpoint simply 404s in production (this happened to /api/node/heartbeat).
// Resolve each target backwards to its source module and fail the build if a
// source file has no entry.
// Map each route entry to the source module it ultimately imports. The target
// points at the synced copy under edge-functions/_hub/, which mirrors
// edgeone-hub/ one-to-one, so strip the _hub prefix to get the source path.
const hubApiDir = join(projectRoot, 'edgeone-hub', 'api');
const hubMirrorDir = join(edgeFuncDir, '_hub');
const registeredSources = new Set(
  apiRoutes.map(({ file, target }) => {
    const synced = resolve(dirname(join(edgeFuncDir, file)), target);
    return synced.startsWith(hubMirrorDir + '/')
      ? join(projectRoot, 'edgeone-hub', synced.slice(hubMirrorDir.length + 1))
      : synced;
  })
);
const missingEntries = [];
(function scanHandlers(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanHandlers(full);
    } else if (entry.name.endsWith('.js')) {
      if (!registeredSources.has(resolve(full))) {
        missingEntries.push(relative(hubApiDir, full));
      }
    }
  }
})(hubApiDir);
if (missingEntries.length > 0) {
  console.error('   ✖ handler modules without a route entry in apiRoutes:');
  for (const m of missingEntries) console.error(`     - edgeone-hub/api/${m}`);
  console.error('   Add the entry to shared/admin/build.mjs apiRoutes, or the endpoint 404s in production.');
  process.exit(1);
}
console.log(`   ✓ all ${registeredSources.size} handler modules have a route entry`);

// Route entry points: one file per route, and each one is registered by the
// platform as its own edge function — their bytes count against the deployment
// budget (Gate 5). The platform statically scans for `export async function
// onRequest*`, so all seven method exports must stay and must keep that exact
// form (`export const onRequestGet = h` would not be scanned); the bytes are won
// back by shortening the identifiers only. hub.test.mjs asserts this shape.
for (const { file, target } of apiRoutes) {
  const filePath = join(edgeFuncDir, file);
  mkdirSync(dirname(filePath), { recursive: true });
  const content = `import { onRequest as h } from '${target}';
export async function onRequest(c){return h(c)}
export async function onRequestGet(c){return h(c)}
export async function onRequestPost(c){return h(c)}
export async function onRequestPut(c){return h(c)}
export async function onRequestPatch(c){return h(c)}
export async function onRequestDelete(c){return h(c)}
export async function onRequestOptions(){return new Response(null,{status:204})}
`;
  writeFileSync(filePath, content, 'utf8');
}
console.log(`   ✓ ${apiRoutes.length} edge-functions/api/ route entry points generated successfully`);

// 11. Gate 5: EdgeOne edge-functions total size.
//
// This gate exists because the Hub went fully dark (545 "Error return from
// script" on every path, build and CI green) twice: v20261123-07 and
// v20261126-02. Both times the platform refused to load the deployed edge
// script: `XX-Script-Debug: query bu_script_<id>.js failed: file too big`.
//
// What is actually measured: the platform registers EVERY file under
// /edge-functions as an edge function (the console's 函数 tab lists them, e.g.
// 27 routes), and bundles them into one script. Its ceiling is far below the
// 5 MB/function the public docs state, and neither the docs nor the console
// expose the number. Three production deploys bracket it:
//
//   2.14.0 (this file's baseline)  125,811 bytes of JS  -> served fine
//   2.15.0                         131,897 bytes        -> whole site 545
//   2.15.0 slimmed                 131,808 bytes        -> whole site 545
//
// So 125,811 is the largest size known to work, and the ceiling lies somewhere
// between it and 131,808 (gzip is not the metric: all three are 26-28 KB gz).
// The budget is that known-good size: any hub change must be paid for by
// deleting something else, or split so it does not touch the edge at all
// (which is why preset auto-binding now lives in the console, not the Hub).
const EDGE_TOTAL_JS_BUDGET = 125811;
function totalJsBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += totalJsBytes(p);
    else if (entry.isFile() && entry.name.endsWith('.js')) total += statSync(p).size;
  }
  return total;
}
const edgeJsBytes = totalJsBytes(edgeFuncDir);
console.log(`\n10. Verifying EdgeOne edge-functions size (${edgeJsBytes} bytes of JS <= ${EDGE_TOTAL_JS_BUDGET})...`);
if (edgeJsBytes > EDGE_TOTAL_JS_BUDGET) {
  console.error(`   ✗ FAILED: edge-functions carries ${edgeJsBytes} bytes of JS, over the ${EDGE_TOTAL_JS_BUDGET}-byte budget`);
  console.error('     The platform refuses to load a deployment above its undocumented script ceiling:');
  console.error('     every path returns 545 with "XX-Script-Debug: file too big". Do not raise this budget');
  console.error('     without a real deploy proving the new number works — delete bytes, or keep the code out of /edge-functions.');
  process.exit(1);
}
console.log(`   ✓ edge-functions JS total ${edgeJsBytes} bytes <= ${EDGE_TOTAL_JS_BUDGET} (headroom ${EDGE_TOTAL_JS_BUDGET - edgeJsBytes})`);

console.log('\n=== ALL 5 HARD GATES PASSED! Dist bundle generated at: ===');
console.log(distPath);
