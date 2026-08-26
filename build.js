// Elyxion site builder — generates static site
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const BUILD = path.join(ROOT, 'dist');
const THEME = path.join(ROOT, 'theme', 'globals.css');

const NOW = new Date().toISOString();
const BUILD_ID = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

function byteLen(str) {
  let len = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) len += 1;
    else if (c < 0x800) len += 2;
    else if (c < 0x10000) len += 3;
    else len += 4;
  }
  return len;
}

// ── Site data ──────────────────────────────────────────
const site = {
  title: 'Elyxion',
  tagline: 'A standalone JavaScript runtime. No Node.js required.',
  version: process.versions?.elyxion || '1.0.0',
  v8: process.versions?.v8 || 'unknown',
  platform: process.platform,
  arch: process.arch,
  installCmd: 'curl -fsSL https://raw.githubusercontent.com/xyz-elyxion/elyxion-cli/main/scripts/install.sh | bash',
  repo: 'https://github.com/xyz-elyxion/elyxion-cli',
};

const pages = {
  '/': { file: 'index.html', title: site.title + ' — Standalone JS Runtime' },
  '/about': { file: 'about.html', title: 'About — ' + site.title },
  '/dashboard': { file: 'dashboard.html', title: 'Dashboard — ' + site.title + ' Registry' },
  '/404': { file: '404.html', title: '404 — ' + site.title },
};

const modules = [
  'events', 'stream', 'buffer', 'path', 'fs', 'http', 'https',
  'net', 'crypto', 'os', 'url', 'util', 'child_process',
  'assert', 'readline', 'dns',
];

// ── Framework theme ────────────────────────────────────
// The site is styled by the elyxion-website framework's shadcn/ui theme.
// It lives in theme/globals.css and is copied to dist/theme/globals.css
// so every page can link to it.
function frameworkTheme() {
  try {
    const css = fs.readFileSync(THEME);
    return css === undefined ? '' : String(css);
  } catch (_) {
    return '/* elyxion-website theme not found — see theme/globals.css */';
  }
}

// ── Helpers ────────────────────────────────────────────

function pageLabel(p, info) {
  const name = info.file.replace('.html', '');
  if (name === 'index') return 'Home';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function layout(title, body, activePage) {
  const nav = Object.entries(pages).filter(([p]) => p !== '/404').map(([p, info]) => {
    const cls = p === activePage ? ' class="active"' : '';
    return `<a href="${p}"${cls}>${pageLabel(p, info)}</a>`;
  }).join('\n            ');

  const footerLinks = Object.entries(pages).filter(([p]) => p !== '/404').map(([p, info]) =>
    `<a href="${p}">${pageLabel(p, info)}</a>`
  ).join('\n          ');

  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="/theme/globals.css">
</head>
<body>
  <nav class="nav">
    <div class="container">
      <a href="/" class="logo">${site.title}</a>
      <div class="nav-links">
        ${nav}
        <a href="${site.repo}" target="_blank" rel="noopener">GitHub</a>
      </div>
    </div>
  </nav>
  ${body}
  <footer>
    <div class="fnav">
      ${footerLinks}
      <a href="https://github.com/xyz-elyxion/elyxion-cli" target="_blank" rel="noopener">GitHub</a>
    </div>
    <p>Built with Elyxion — build <code>${BUILD_ID}</code> at ${NOW}</p>
  </footer>
</body>
</html>`;
}

const LIVE_COUNTERS_JS = `
  <script>
    // Live registry counters
    function setNum(id, n) {
      var el = document.getElementById(id);
      if (el) el.textContent = n.toLocaleString();
    }
    function fmtUptime(s) {
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
      return Math.floor(s / 3600) + 'h';
    }
    fetch('/api/stats').then(function (r) { return r.json(); }).then(function (d) {
      setNum('c-pkgs', d.packages); setNum('c-users', d.users); setNum('c-versions', d.versions);
    }).catch(function () { setNum('c-pkgs', 0); setNum('c-users', 0); setNum('c-versions', 0); });
    fetch('/health').then(function (r) { return r.json(); }).then(function (d) {
      document.getElementById('c-uptime').textContent = fmtUptime(d.uptime);
    }).catch(function () { document.getElementById('c-uptime').textContent = '—'; });
  </script>`;

// ── Page: Home ─────────────────────────────────────────
function buildHome() {
  const features = [
    { icon: '⚡', title: 'Zero Dependencies', desc: 'Built directly on V8 and libuv. No npm, no <code>node_modules</code> — just a single binary.' },
    { icon: '📦', title: 'Built-in Package Manager', desc: '<code>elyx init</code>, <code>elyx install</code>, <code>elyx publish</code> — all included.' },
    { icon: '🌐', title: 'Full HTTP Stack', desc: 'HTTP server, client, and routing. This site is served by Elyxion itself.' },
    { icon: '🔐', title: 'Crypto &amp; Buffers', desc: 'Hashing, HMAC, and binary data handling built into the runtime.' },
    { icon: '📂', title: 'File System', desc: 'Read, write, and stream files — all with a familiar Node-compatible API.' },
    { icon: '🖥️', title: 'REPL &amp; CLI', desc: 'Interactive shell for quick experiments. Perfect for scripting.' },
  ];

  const body = `
  <section class="hero">
    <div class="grid-bg"></div>
    <div class="content">
      <span class="badge"><span class="dot"></span> All systems operational · 99.98% uptime</span>
      <h1>
        <span class="text-light">A standalone JavaScript runtime.</span><br>
        <span class="text-cool">No Node.js required.</span>
      </h1>
      <p class="tagline">Zero dependencies, one binary. Built on V8 and libuv — with a built-in package manager, registry, and web dashboard.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="/dashboard">Open dashboard</a>
        <a class="btn btn-ghost" href="${site.repo}" target="_blank" rel="noopener">View on GitHub</a>
      </div>
      <div class="counters">
        <div class="counter"><div class="num" id="c-pkgs">—</div><div class="lbl">Packages</div></div>
        <div class="counter"><div class="num" id="c-users">—</div><div class="lbl">Users</div></div>
        <div class="counter"><div class="num" id="c-versions">—</div><div class="lbl">Versions</div></div>
        <div class="counter"><div class="num" id="c-uptime">—</div><div class="lbl">Uptime</div></div>
      </div>
    </div>
  </section>
  <section class="features">
    ${features.map(f => `
    <div class="card">
      <div class="icon">${f.icon}</div>
      <h3>${f.title}</h3>
      <p>${f.desc}</p>
    </div>`).join('')}
  </section>
  ${LIVE_COUNTERS_JS}`;

  return layout(pages['/'].title, body, '/');
}

// ── Page: About ────────────────────────────────────────
function buildAbout() {
  const body = `
  <div class="page">
    <h1 class="text-cool">About Elyxion</h1>
    <p>Elyxion is a <strong>standalone JavaScript runtime</strong> built on V8 and libuv. It runs JavaScript outside the browser without needing Node.js, npm, or any other dependency. A single native binary handles everything.</p>
    <h2>Why Elyxion?</h2>
    <p>Node.js is great, but it carries a lot of baggage — a massive standard library, a package manager that pulls in thousands of files, and a build system that requires native addons. Elyxion strips all that away. You get V8, a focused set of built-in modules, and a zero-install package manager — all in one binary.</p>
    <h2>Built-in Modules</h2>
    <div class="module-grid">
      ${modules.map(m => `<span class="module-tag">${m}</span>`).join('\n      ')}
    </div>
    <h2>How This Site Works</h2>
    <p>This site is generated by <code>elyxion build.js</code> — a single JavaScript file running on the Elyxion runtime. No frameworks, no dependencies, no <code>node_modules</code>. The builder reads templates, assembles pages, and writes them to disk using only Elyxion's built-in <code>fs</code>, <code>path</code>, and <code>crypto</code> modules.</p>
    <h2>Install</h2>
    <div class="codeblock"><span class="prompt">$ </span>${site.installCmd}</div>
  </div>`;

  return layout(pages['/about'].title, body, '/about');
}

// ── Page: 404 ──────────────────────────────────────────
function build404() {
  const body = `
  <div class="nf">
    <h1 class="text-cool">404</h1>
    <p>Page not found</p>
    <p style="margin-top:1.5rem"><a href="/">← Back home</a></p>
  </div>`;

  return layout(pages['/404'].title, body, '/404');
}

// ── Generate JSON API ──────────────────────────────────
function buildAPI() {
  return JSON.stringify({
    runtime: site.title,
    version: site.version,
    v8: site.v8,
    platform: site.platform,
    arch: site.arch,
    modules: modules,
    build: { id: BUILD_ID, time: NOW },
    repo: site.repo,
  }, null, 2);
}

// ── Build ──────────────────────────────────────────────
console.log(`\n  ⚡ Elyxion Site Builder`);
console.log(`     v${site.version} on ${site.platform}/${site.arch}\n`);

// Clean previous build
if (fs.existsSync(BUILD)) {
  console.log('  Cleaning dist/...');
  const rmDir = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry);
      if (fs.statSync(p).isDirectory()) { rmDir(p); } else { fs.unlinkSync(p); }
    }
    fs.rmdirSync(dir);
  };
  rmDir(BUILD);
}

fs.mkdirSync(BUILD, { recursive: true });

// Generate pages
const pageMap = {
  'index.html': buildHome(),
  'about.html': buildAbout(),
  '404.html': build404(),
};

for (const [file, html] of Object.entries(pageMap)) {
  const out = path.join(BUILD, file);
  fs.writeFileSync(out, html, 'utf-8');
  const size = (byteLen(html) / 1024).toFixed(1);
  console.log(`  ✓ ${file} (${size} KB)`);
}

// Copy static assets from public/ that aren't generated (e.g. the
// management dashboard — it's a self-contained page served as-is).
const staticAssets = ['dashboard.html'];
for (const file of staticAssets) {
  const src = path.join(PUBLIC, file);
  if (!fs.existsSync(src)) continue;
  const html = fs.readFileSync(src, 'utf-8');
  fs.writeFileSync(path.join(BUILD, file), html, 'utf-8');
  const size = (byteLen(html) / 1024).toFixed(1);
  console.log(`  ✓ ${file} (${size} KB)`);
}

// Copy the framework theme so the linked stylesheet resolves.
const themeCss = frameworkTheme();
if (themeCss && !themeCss.startsWith('/* elyxion-website theme not found')) {
  fs.mkdirSync(path.join(BUILD, 'theme'), { recursive: true });
  fs.writeFileSync(path.join(BUILD, 'theme', 'globals.css'), themeCss, 'utf-8');
  console.log(`  ✓ theme/globals.css (${(byteLen(themeCss) / 1024).toFixed(1)} KB)`);
} else {
  console.log('  ! theme/globals.css not found — pages will be unstyled');
}

// Generate API
const apiJSON = buildAPI();
fs.writeFileSync(path.join(BUILD, 'api.json'), apiJSON, 'utf-8');
console.log(`  ✓ api.json (${(byteLen(apiJSON) / 1024).toFixed(1)} KB)`);

// Build summary
const buildInfo = {
  buildId: BUILD_ID,
  builtAt: NOW,
  version: site.version,
  platform: site.platform,
  arch: site.arch,
  pages: Object.keys(pageMap).length,
};

fs.writeFileSync(path.join(BUILD, 'build.json'), JSON.stringify(buildInfo, null, 2), 'utf-8');

console.log(`\n  ✓ Site built to dist/ (build ${BUILD_ID})`);
console.log(`  Run: elyxion site/server.js\n`);
