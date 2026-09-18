#!/bin/sh
# Rebrand the vendored code-server runtime as "Elyxion Codespace".
#
#   sh scripts/rebrand-ide.sh
#
# Edits the installed runtime in .code-server-src/runtime (git-ignored — the
# Docker build re-runs this script after `npm install code-server`, so the
# branding survives fresh builds). Rewrites:
#   • lib/vscode/product.json        — app names (window title, menus, about)
#   • lib/vscode/resources/server/manifest.json — PWA name
#   • lib/vscode/out/vs/code/browser/workbench/workbench.html — <title>, aria
#   • lib/vscode/out/vs/code/browser/workbench/callback.html — auth-callback title
#   • workbench.js / cli.js strings — user-visible "code-server" / "Visual
#     Studio Code" labels inside the web bundles (byte-length-preserving so no
#     sourcemap/hash churn matters)
set -e
cd "$(dirname "$0")/.."

RUNTIME=".code-server-src/runtime/node_modules/code-server"
[ -d "$RUNTIME" ] || { echo "runtime not found — install it first (see .code-server-src/README.md)" >&2; exit 1; }

node - "$RUNTIME" <<'EOF'
const fs = require('fs');
const path = require('path');
const runtime = process.argv[2];

// ── product.json + manifest ────────────────────────────────────────────────
const productPath = path.join(runtime, 'lib/vscode/product.json');
const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
product.nameShort = 'Elyxion Codespace';
product.nameLong = 'Elyxion Codespace';
product.applicationName = 'elyxion-codespace';
product.dataFolderName = '.elyxion-codespace';
product.win32MutexName = 'elyxioncodespace';
product.win32DirName = 'Elyxion Codespace';
product.win32NameVersion = 'Elyxion Codespace';
product.win32ShellNameShort = 'Ely&xion Codespace';
product.linuxIconName = 'elyxion-codespace';
product.urlProtocol = 'elyxion-codespace';
product.reportIssueUrl = 'https://xyz-elyxion.onrender.com/docs';
product.documentationUrl = 'https://xyz-elyxion.onrender.com/docs';
fs.writeFileSync(productPath, JSON.stringify(product, null, '\t'));

const manifestPath = path.join(runtime, 'lib/vscode/resources/server/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.name = 'Elyxion Codespace';
manifest.short_name = 'Codespace';
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t'));

// ── HTML shells ────────────────────────────────────────────────────────────
// workbench.html has no <title> (VS Code sets document.title from
// product.nameLong at runtime) but does carry PWA meta labels.
const htmlDir = path.join(runtime, 'lib/vscode/out/vs/code/browser/workbench');
for (const file of ['workbench.html', 'callback.html']) {
  const p = path.join(htmlDir, file);
  if (!fs.existsSync(p)) continue;
  let html = fs.readFileSync(p, 'utf8')
    .replace(/content="Code"/g, 'content="Codespace"')
    .replace(/<title>[^<]*<\/title>/g, '<title>Elyxion Codespace</title>');
  fs.writeFileSync(p, html);
}

// ── Web bundle strings ─────────────────────────────────────────────────────
// Byte-length-preserving replacements inside the minified bundles. Shorter
// replacements are padded with spaces (harmless inside string literals);
// nothing may come out LONGER than the original or offsets could shift.
function patch(file, pairs) {
  const p = path.join(runtime, file);
  if (!fs.existsSync(p)) return;
  let src = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) {
    if (to.length > from.length) throw new Error(`replacement longer than source: ${from}`);
    const padded = to + ' '.repeat(from.length - to.length);
    src = src.split(from).join(padded);
  }
  fs.writeFileSync(p, src);
  console.log('patched', file);
}

// "Visual Studio Code" = 18 chars, "Elyxion Codespace" = 17 → pad 1.
const VS = ['Visual Studio Code', 'Elyxion Codespace '];
// "code-server" = 11, "Codespace" = 9 → pad 2. Safe to replace plainly: the
// asset URLs use versioned paths (stable-<commit>/static/...), not this word.
const CS = ['code-server', 'Codespace  '];
// "Code - OSS" = 10, "Codespace" = 9 → pad 1.
const OSS = ['Code - OSS', 'Codespace '];

patch('lib/vscode/out/vs/code/browser/workbench/workbench.js', [VS, CS, OSS]);
patch('lib/vscode/out/node/app.js', [VS, CS]);
patch('lib/vscode/out/node/cli.js', [CS]);

// ── Favicon ────────────────────────────────────────────────────────────────
// Swap code-server's favicon for the game's own (public/favicon.svg — the cyan
// reticle), so the browser tab matches the rest of Elyxion. Only runs when the
// game's favicon is present, so the script stays safe in the Docker ide stage.
const gameFavicon = 'public/favicon.svg';
if (fs.existsSync(gameFavicon)) {
  const media = path.join(runtime, 'src/browser/media');
  for (const name of ['favicon-dark-support.svg', 'favicon.svg']) {
    const dst = path.join(media, name);
    if (fs.existsSync(dst)) fs.copyFileSync(gameFavicon, dst);
  }
  // .ico fallback: reuse the existing one (browser picks the .svg on modern
  // browsers anyway); the PNG pwa-icons keep code-server's defaults.
  console.log('favicon swapped to the Elyxion reticle.');
}

console.log('Elyxion Codespace branding applied.');
EOF
