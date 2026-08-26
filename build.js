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
  '/dashboard': { file: 'dashboard.html', title: 'Dashboard — ' + site.title + ' Registry' },
  '/404': { file: '404.html', title: '404 — ' + site.title },
};

const modules = [
  'events', 'stream', 'buffer', 'path', 'fs', 'http', 'https',
  'net', 'crypto', 'os', 'url', 'util', 'child_process',
  'assert', 'readline', 'dns',
];

// ── Design system (doublecounter.gg-inspired) ───────────
const STYLE = `
  :root {
    --bg: rgb(5 5 8);
    --card: hsl(240 10% 6%);
    --border: hsl(240 6% 14%);
    --border-strong: hsl(240 6% 22%);
    --fg: hsl(0 0% 98%);
    --muted: hsl(240 5% 65%);
    --violet: hsl(256 90% 66%);
    --periwinkle: #9475f0;
    --cyan: hsl(191 91% 60%);
    --brand: hsl(354 93% 60%);
    --success: hsl(142 71% 45%);
    --radius: 0.75rem;
  }
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body {
    font-family: 'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.6;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  .container { max-width:1080px; margin:0 auto; padding:0 1.5rem; }
  a { color:inherit; text-decoration:none; }

  /* Gradient text */
  .text-cool {
    background: linear-gradient(135deg, hsl(256 90% 66%) 0%, #9475f0 50%, hsl(191 91% 60%) 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .text-light {
    background: linear-gradient(#fff 0%, #999 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }

  /* Nav */
  .nav {
    position: sticky; top:0; z-index:20;
    border-bottom:1px solid var(--border);
    background: rgb(5 5 8 / 0.8);
    backdrop-filter: blur(12px);
  }
  .nav .container { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding-top:1rem; padding-bottom:1rem; }
  .logo { font-weight:800; font-size:1.15rem; letter-spacing:-0.02em; }
  .nav-links { display:flex; align-items:center; gap:1.75rem; }
  .nav-links a { color:var(--muted); font-size:0.9rem; transition:color .15s; }
  .nav-links a:hover { color:var(--fg); }
  .nav-links a.active { color:var(--fg); }
  .nav-links a.active::after { content:''; display:block; height:2px; border-radius:2px; margin-top:2px;
    background: linear-gradient(90deg, var(--violet), var(--cyan)); }

  /* Hero */
  .hero { position:relative; overflow:hidden; text-align:center; padding:6.5rem 1.5rem 4rem; }
  .grid-bg {
    position:absolute; inset:0; pointer-events:none; opacity:.45;
    background-image:
      linear-gradient(to right, hsl(240 6% 14% / .3) 1px, transparent 1px),
      linear-gradient(to bottom, hsl(240 6% 14% / .3) 1px, transparent 1px);
    background-size:24px 24px;
    -webkit-mask-image:radial-gradient(#000 10%, transparent 65%);
    mask-image:radial-gradient(#000 10%, transparent 65%);
  }
  .hero .content { position:relative; max-width:820px; margin:0 auto; }
  .badge {
    display:inline-flex; align-items:center; gap:0.5rem;
    border:1px solid hsl(142 71% 45% / .4); background:hsl(142 71% 45% / .12);
    color:var(--success); border-radius:999px; padding:0.32rem 0.95rem;
    font-size:0.8rem; font-weight:500;
  }
  .badge .dot {
    width:7px; height:7px; border-radius:50%; background:var(--success);
    animation:pulse 2s cubic-bezier(.4,0,.6,1) infinite;
  }
  @keyframes pulse { 0%,100% {opacity:1} 50% {opacity:.35} }
  .hero h1 {
    margin-top:1.6rem; font-size:clamp(2.5rem, 6vw, 4.25rem);
    font-weight:700; line-height:1.06; letter-spacing:-0.02em;
    text-wrap:balance;
  }
  .hero .tagline { margin:1.4rem auto 0; max-width:640px; font-size:clamp(1.05rem, 2vw, 1.25rem); color:var(--muted); }
  .cta-row { margin-top:2.4rem; display:flex; gap:0.9rem; justify-content:center; flex-wrap:wrap; }
  .btn {
    display:inline-block; padding:0.72rem 1.6rem; border-radius:10px;
    font-size:0.95rem; font-weight:600; transition:filter .15s, transform .15s, border-color .15s;
    cursor:pointer; border:1px solid transparent;
  }
  .btn:hover { filter:brightness(1.12); transform:translateY(-1px); }
  .btn-primary {
    background: linear-gradient(135deg, hsl(354 93% 60%), hsl(354 84% 50%) 60%, hsl(354 86% 40%));
    color:#fff;
  }
  .btn-ghost { background:transparent; border-color:var(--border-strong); color:var(--fg); }
  .btn-ghost:hover { border-color:var(--violet); }

  /* Live counters */
  .counters {
    margin-top:3.75rem; display:flex; justify-content:center; gap:2rem 3.5rem; flex-wrap:wrap;
  }
  .counter { text-align:center; }
  .counter .num {
    font-family:'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size:1.9rem; font-weight:600; font-variant-numeric:tabular-nums; letter-spacing:-0.02em;
    background: linear-gradient(135deg, hsl(256 90% 66%) 0%, #9475f0 50%, hsl(191 91% 60%) 100%);
    -webkit-background-clip:text; background-clip:text; color:transparent;
  }
  .counter .lbl { margin-top:0.2rem; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); }

  /* Cards / sections */
  .features {
    display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr));
    gap:1.25rem; max-width:1080px; margin:4.5rem auto; padding:0 1.5rem;
  }
  .card {
    background:var(--card); border:1px solid var(--border); border-radius:var(--radius);
    padding:1.6rem; transition:border-color .2s, transform .2s;
  }
  .card:hover { border-color:var(--border-strong); transform:translateY(-2px); }
  .card .icon { font-size:1.5rem; margin-bottom:0.85rem; }
  .card h3 { font-size:1.08rem; font-weight:600; margin-bottom:0.5rem; }
  .card p { font-size:0.9rem; color:var(--muted); }
  .card code, p code {
    font-family:'Geist Mono', ui-monospace, Menlo, Consolas, monospace;
    font-size:0.85em; color:var(--cyan);
  }

  /* Page (about) */
  .page { max-width:720px; margin:4.5rem auto; padding:0 1.5rem; }
  .page h1 { font-size:2.6rem; font-weight:700; letter-spacing:-0.02em; margin-bottom:1.5rem; }
  .page h2 { font-size:1.25rem; font-weight:600; margin:2.75rem 0 0.9rem; }
  .page p { color:var(--muted); margin-bottom:1rem; }
  .page strong { color:var(--fg); }
  .module-grid { display:flex; flex-wrap:wrap; gap:0.5rem; margin:1rem 0; }
  .module-tag {
    background:var(--card); border:1px solid var(--border); border-radius:6px;
    padding:0.35rem 0.8rem; font-family:'Geist Mono', ui-monospace, Menlo, Consolas, monospace;
    font-size:0.82rem; color:var(--fg);
  }
  .codeblock {
    background:var(--card); border:1px solid var(--border); border-radius:var(--radius);
    padding:1.1rem 1.3rem; font-family:'Geist Mono', ui-monospace, Menlo, Consolas, monospace;
    font-size:0.85rem; color:var(--cyan); overflow-x:auto; margin:1.25rem 0;
  }
  .codeblock .prompt { color:var(--muted); }

  /* 404 */
  .nf { text-align:center; padding:8rem 1.5rem; }
  .nf h1 { font-size:clamp(5rem, 16vw, 8rem); font-weight:800; letter-spacing:-0.03em; line-height:1; }
  .nf p { color:var(--muted); font-size:1.15rem; margin-top:0.75rem; }
  .nf a { color:var(--violet); }
  .nf a:hover { text-decoration:underline; }

  /* Footer */
  footer { border-top:1px solid var(--border); padding:2rem 1.5rem; text-align:center; }
  footer .fnav { display:flex; justify-content:center; gap:1.5rem; margin-bottom:1rem; }
  footer .fnav a { color:var(--muted); font-size:0.85rem; }
  footer .fnav a:hover { color:var(--fg); }
  footer p { color:#484f58; font-size:0.78rem; }
  footer code { font-family:'Geist Mono', ui-monospace, Menlo, Consolas, monospace; }

  @media (max-width:600px) {
    .nav .container { flex-wrap:wrap; justify-content:center; }
    .hero { padding-top:4.5rem; }
    .counters { gap:1.5rem 2.5rem; }
  }
`;

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
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>${STYLE}</style>
</head>
<body>
  <nav class="nav">
    <div class="container">
      <a href="/" class="logo text-cool">${site.title}</a>
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
  const html = fs.readFileSync(src);
  fs.writeFileSync(path.join(BUILD, file), html, 'utf-8');
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
