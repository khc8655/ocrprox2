#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
    .join('\n');
}
const cleanIconsJs = cleanJs(iconsJs);
const cleanUsageJs = cleanJs(usageJs);
const cleanHostJs = cleanJs(hostJs);
const cleanAppJs = cleanJs(appJs);
let bundledHtml = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)
  .join('\n');
bundledHtml = bundledHtml.replace('<link rel="stylesheet" href="css/app.css">', `<style>\n${minCss}\n</style>`);
bundledHtml = bundledHtml.replace('<script src="js/icons.js"></script>', `<script>\n${cleanIconsJs}\n</script>`);
bundledHtml = bundledHtml.replace('<script src="js/usage.js"></script>', `<script>\n${cleanUsageJs}\n</script>`);
bundledHtml = bundledHtml.replace('<script src="js/host.js"></script>', `<script>\n${cleanHostJs}\n</script>`);
bundledHtml = bundledHtml.replace('<script src="js/app.js"></script>', `<script>\n${cleanAppJs}\n</script>`);

mkdirSync(distDir, { recursive: true });
const distPath = join(distDir, 'index.html');
writeFileSync(distPath, bundledHtml, 'utf8');

const internalAssetHtml = join(projectRoot, 'internal/admin/assets/index.html');
if (existsSync(dirname(internalAssetHtml))) {
  writeFileSync(internalAssetHtml, bundledHtml, 'utf8');
}

// 7. Gate 4: Bundle size <= 245,760 bytes (240 KB)
console.log('\n6. Verifying Gate 4: Bundle size (<= 245,760 bytes)...');
const stat = statSync(distPath);
const sizeKb = (stat.size / 1024).toFixed(2);
console.log(`   Bundle size: ${stat.size} bytes (${sizeKb} KB)`);

if (stat.size > 245760) {
  console.error(`   ✗ FAILED: Bundle size ${stat.size} bytes (${sizeKb} KB) exceeds 245,760 bytes limit!`);
  process.exit(1);
}
console.log(`   ✓ Bundle size ${stat.size} bytes (${sizeKb} KB) <= 245,760 bytes limit (100% compliant)`);

// 8. Generate edge-functions/admin.js (EdgeOne Hub Console)
console.log('\n7. Generating edge-functions/admin.js (EdgeOne Hub Console)...');
const edgeFuncDir = join(projectRoot, 'edge-functions');
mkdirSync(edgeFuncDir, { recursive: true });

let hubHtml = bundledHtml
  .replace('<head>', '<head>\n  <script>window.__HOST_KIND__="hub";</script>')
  .replace(`<script>\n${cleanUsageJs}\n</script>`, '');

const safeHtml = hubHtml.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const adminJsContent = `/**
 * Self-contained admin UI for LLMProxy2 EdgeOne Hub.
 * Generated by shared/admin/build.mjs; do not edit directly.
 */

function pageHtml() {
  return \`${safeHtml}\`;
}

export function onRequestGet(context) {
  return new Response(pageHtml(), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-xss-protection": "1; mode=block",
      "referrer-policy": "strict-origin-when-cross-origin"
    },
  });
}

export function onRequestHead(context) {
  return onRequestGet(context);
}

export function onRequest(context) {
  return onRequestGet(context);
}

export default {
  async fetch(request, env, context) {
    return onRequestGet({ request, env, ...context });
  }
};
`;

const edgeAdminPath = join(edgeFuncDir, 'admin.js');
writeFileSync(edgeAdminPath, adminJsContent, 'utf8');
console.log(`   ✓ edge-functions/admin.js generated successfully (${adminJsContent.length} bytes)`);

// 9. Sync pure Web Standard hub files to edge-functions/_hub/ (Self-Contained Edge Packaging)
console.log('\n8. Synchronizing edgeone-hub to edge-functions/_hub/ (Self-Contained Edge Functions)...');
const hubDir = join(projectRoot, 'edgeone-hub');
const generatedPresetsPath = join(hubDir, 'lib/generated-presets.js');
if (!existsSync(generatedPresetsPath)) {
  console.log('   Generating presets catalog & pre-compiled presets map first...');
  execFileSync('node', [join(projectRoot, 'shared/presets/build-catalog.mjs')], { stdio: 'inherit' });
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
      writeFileSync(destPath, content, 'utf8');
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
  { file: 'api/admin/nodes.js', target: '../../_hub/api/admin/nodes.js' },
  { file: 'api/admin/nodes/[id].js', target: '../../../_hub/api/admin/nodes.js' },
  { file: 'api/admin/nodes/[id]/rotate.js', target: '../../../../_hub/api/admin/nodes.js' },
  { file: 'api/admin/nodes/[[default]].js', target: '../../../_hub/api/admin/nodes.js' },
  { file: 'api/admin/verify-key.js', target: '../../_hub/api/admin/verify-key.js' },
  { file: 'api/admin/probe-models.js', target: '../../_hub/api/admin/probe-models.js' },
  { file: 'api/vault/manifest.js', target: '../../_hub/api/vault/manifest.js' },
  { file: 'api/vault/fetch.js', target: '../../_hub/api/vault/fetch.js' },
];

for (const { file, target } of apiRoutes) {
  const filePath = join(edgeFuncDir, file);
  mkdirSync(dirname(filePath), { recursive: true });
  const content = `import { onRequest as _onRequest } from '${target}';

export async function onRequest(context) { return _onRequest(context); }
export async function onRequestGet(context) { return _onRequest(context); }
export async function onRequestPost(context) { return _onRequest(context); }
export async function onRequestPut(context) { return _onRequest(context); }
export async function onRequestPatch(context) { return _onRequest(context); }
export async function onRequestDelete(context) { return _onRequest(context); }
export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}
`;
  writeFileSync(filePath, content, 'utf8');
}
console.log(`   ✓ ${apiRoutes.length} edge-functions/api/ route entry points generated successfully`);

console.log('\n=== ALL 5 HARD GATES PASSED! Dist bundle generated at: ===');
console.log(distPath);
