// Elyxion site builder — generates static site
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const BUILD = path.join(ROOT, 'dist');

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
  '/404': { file: '404.html', title: '404 — ' + site.title },
};

const modules = [
  'events', 'stream', 'buffer', 'path', 'fs', 'http', 'https',
  'net', 'crypto', 'os', 'url', 'util', 'child_process',
  'assert', 'readline', 'dns',
];

// ── Helpers ────────────────────────────────────────────

function layout(title, body, activePage) {
  const nav = Object.entries(pages).filter(([p]) => p !== '/404').map(([p, info]) => {
    const cls = p === activePage ? ' class="active"' : '';
    return `<a href="${p}"${cls}>${info.file.replace('.html', '') === 'index' ? 'Home' : info.file.replace('.html', '').charAt(0).toUpperCase() + info.file.replace('.html', '').slice(1)}</a>`;
  }).join('\n            ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:system-ui,-apple-system,sans-serif; background:#0d1117; color:#c9d1d9; line-height:1.6; min-height:100vh; }
    nav { display:flex; justify-content:center; gap:1.5rem; padding:1.25rem 2rem; border-bottom:1px solid #21262d; }
    nav a { color:#8b949e; text-decoration:none; font-size:0.9rem; transition:color 0.15s; }
    nav a:hover, nav a.active { color:#a78bfa; }
    .page { ${activePage === '/' ? '' : 'max-width:720px; margin:3rem auto; padding:0 2rem;'} }
    .hero { text-align:center; padding:5rem 2rem 3rem; border-bottom:1px solid #21262d; }
    .hero h1 { font-size:3.5rem; font-weight:800; background:linear-gradient(135deg,#a78bfa,#60a5fa); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
    .hero .tagline { font-size:1.25rem; color:#8b949e; margin-top:1rem; }
    .install { margin-top:2rem; display:inline-block; background:#161b22; border:1px solid #30363d; border-radius:8px; padding:0.75rem 1.5rem; font-family:'Fira Code',Consolas,monospace; font-size:0.9rem; color:#58a6ff; }
    h1 { font-size:2.5rem; font-weight:800; margin-bottom:1.5rem; color:#e6edf3; }
    h2 { font-size:1.25rem; margin:2.5rem 0 0.75rem; color:#e6edf3; }
    p { color:#8b949e; margin-bottom:1rem; }
    code { background:#161b22; border:1px solid #30363d; border-radius:4px; padding:0.15em 0.4em; font-family:'Fira Code',Consolas,monospace; font-size:0.9em; color:#58a6ff; }
    .features { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:1.5rem; max-width:1000px; margin:4rem auto; padding:0 2rem; }
    .card { background:#161b22; border:1px solid #21262d; border-radius:12px; padding:1.5rem; transition:border-color 0.2s; }
    .card:hover { border-color:#8b5cf6; }
    .card .icon { font-size:1.5rem; margin-bottom:0.75rem; }
    .card h3 { font-size:1.1rem; margin-bottom:0.5rem; color:#e6edf3; }
    .card p { font-size:0.9rem; color:#8b949e; }
    .module-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:0.5rem; margin:1rem 0; }
    .module-tag { background:#161b22; border:1px solid #21262d; border-radius:6px; padding:0.4rem 0.75rem; font-size:0.85rem; font-family:'Fira Code',Consolas,monospace; color:#c9d1d9; text-align:center; }
    .stats { max-width:720px; margin:2rem auto 4rem; padding:0 2rem; display:grid; grid-template-columns:repeat(4,1fr); gap:1.5rem; text-align:center; }
    .stat .number { font-size:2rem; font-weight:700; color:#a78bfa; }
    .stat .label { font-size:0.85rem; color:#8b949e; margin-top:0.25rem; }
    footer { text-align:center; padding:2rem; border-top:1px solid #21262d; color:#484f58; font-size:0.8rem; }
    footer nav { display:flex; justify-content:center; gap:1rem; border:none; padding:0 0 1rem; }
    footer nav a { color:#8b949e; text-decoration:none; font-size:0.85rem; }
    footer nav a:hover { color:#a78bfa; }
    .build-info { font-size:0.7rem; color:#30363d; margin-top:0.5rem; }
    @media (max-width:600px) { .hero h1 { font-size:2.2rem; } .stats { grid-template-columns:repeat(2,1fr); } }
  </style>
</head>
<body>
  <nav>
    ${nav}
    <a href="${site.repo}" target="_blank" rel="noopener">GitHub</a>
  </nav>
  ${body}
  <footer>
    <nav>
      ${Object.entries(pages).filter(([p]) => p !== '/404').map(([p]) => `<a href="${p}">${p === '/' ? 'Home' : p.slice(1).charAt(0).toUpperCase() + p.slice(1).slice(1)}</a>`).join('\n            ')}
      <a href="https://github.com/xyz-elyxion/elyxion-cli" target="_blank" rel="noopener">GitHub</a>
    </nav>
    <p>Built with Elyxion — build <code>${BUILD_ID}</code> at ${NOW}</p>
  </footer>
</body>
</html>`;
}

// ── Page: Home ─────────────────────────────────────────
function buildHome() {
  const features = [
    { icon: '⚡', title: 'Zero Dependencies', desc: 'Built directly on V8 and libuv. No npm, no node_modules — just a single binary.' },
    { icon: '📦', title: 'Built-in Package Manager', desc: '<code>elyx init</code>, <code>elyx install</code>, <code>elyx publish</code> — all included.' },
    { icon: '🌐', title: 'Full HTTP Stack', desc: 'HTTP server, client, and routing. This site is generated by Elyxion.' },
    { icon: '🔐', title: 'Crypto &amp; Buffers', desc: 'Hashing, HMAC, and binary data handling built into the runtime.' },
    { icon: '📂', title: 'File System', desc: 'Read, write, and stream files — all with a familiar Node-compatible API.' },
    { icon: '🖥️', title: 'REPL &amp; CLI', desc: 'Interactive shell for quick experiments. Perfect for scripting.' },
  ];

  const body = `
  <section class="hero">
    <h1>${site.title}</h1>
    <p class="tagline">${site.tagline}</p>
    <div class="install">$ ${site.installCmd}</div>
  </section>
  <section class="features">
    ${features.map(f => `
    <div class="card">
      <div class="icon">${f.icon}</div>
      <h3>${f.title}</h3>
      <p>${f.desc}</p>
    </div>`).join('')}
  </section>
  <section class="stats">
    <div class="stat"><div class="number">${site.title}</div><div class="label">Runtime</div></div>
    <div class="stat"><div class="number">V8 ${site.v8}</div><div class="label">Engine</div></div>
    <div class="stat"><div class="number">${site.platform}/${site.arch}</div><div class="label">Platform</div></div>
    <div class="stat"><div class="number">${modules.length}</div><div class="label">Built-in Modules</div></div>
  </section>`;

  return layout(pages['/'].title, body, '/');
}

// ── Page: About ────────────────────────────────────────
function buildAbout() {
  const body = `
  <div class="page">
    <h1>About Elyxion</h1>
    <p>Elyxion is a <strong>standalone JavaScript runtime</strong> built on V8 and libuv. It runs JavaScript outside the browser without needing Node.js, npm, or any other dependency. A single native binary handles everything.</p>
    <h2>Why Elyxion?</h2>
    <p>Node.js is great, but it carries a lot of baggage — a massive standard library, a package manager that pulls in thousands of files, and a build system that requires native addons. Elyxion strips all that away. You get V8, a focused set of built-in modules, and a zero-install package manager — all in one binary.</p>
    <h2>Built-in Modules</h2>
    <div class="module-grid">
      ${modules.map(m => `<span class="module-tag">${m}</span>`).join('\n            ')}
    </div>
    <h2>How This Site Works</h2>
    <p>This site is generated by <code>elyxion site/build.js</code> — a single JavaScript file running on the Elyxion runtime. No frameworks, no dependencies, no <code>node_modules</code>. The builder reads templates, assembles pages, and writes them to disk using only Elyxion's built-in <code>fs</code>, <code>path</code>, and <code>crypto</code> modules.</p>
    <h2>Install</h2>
    <p><code>${site.installCmd}</code></p>
  </div>`;

  return layout(pages['/about'].title, body, '/about');
}

// ── Page: 404 ──────────────────────────────────────────
function build404() {
  const body = `
  <div class="page" style="text-align:center; margin-top:8rem;">
    <h1 style="font-size:6rem; color:#8b5cf6;">404</h1>
    <p style="font-size:1.25rem;">Page not found</p>
    <p><a href="/" style="color:#a78bfa; text-decoration:none;">← Back home</a></p>
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