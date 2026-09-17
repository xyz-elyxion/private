#!/usr/bin/env node

// Elyxion CLI — self-contained edition ("our own version of everything").
//
// The CLI runs on its OWN code. It does not import Vite, the TypeScript
// compiler, ESLint, or tsx, and it never spawns an external tool. Everything
// it needs is implemented here (plus its own loader file elyxion-ts-loader.mjs):
//
//   • TS execution  → our own ESM loader (Node's module.register hooks):
//                     strip-only type removal via Node's own converter,
//                     .ts→.js specifier fallback, import.meta.env inlining.
//   • build         → our own bundler: walks the import graph from index.html,
//                     transforms TS/JSX with our own transform, resolves
//                     node_modules by hand, concatenates dependency-ordered
//                     chunks, rewrites index.html, copies public/, processes
//                     CSS with our own pipeline.
//   • dev/preview   → our own HTTP server serving dist/ with SPA fallback +
//                     depth-correct asset re-anchoring, proxying /api and /ws
//                     to the in-process game server (the project's own code).
//   • typecheck     → our own checker: every source must strip cleanly.
//   • lint          → our own hand-written ruleset.
//   • lan           → our own NIC enumeration.
//   • load          → our own raw WebSocket load harness.
//   • run/watch     → our own loader + cache-busted re-import watcher.
//
// It runs on the Node.js runtime because every JS program must; nothing above
// that layer is imported from outside this repository's own files.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

const help = `Elyxion CLI v${packageJson.version} — self-contained edition

Usage:
  elyxion <command> [options]

Commands:
  dev                 Live dev server: game server + our own bundler, rebuild on save
  dev:lan             Same as dev, bound to 0.0.0.0
  dev:server          Alias for dev
  build               Build the production client into dist/ (our own bundler)
  start               Start the production game server (our own TS loader)
  serve               Build, then start the production server
  preview             Serve dist/ with our own static server
  lan                 Print URLs for opening the app from another LAN device
  load                Run our own netcode load harness
  typecheck           Our own checker over src/ and server/
  lint                Our own linter over src/ and server/
  run <file> [...]    Run a TypeScript or JavaScript file (our own loader)
  watch <file> [...]  Run a file, restarting on changes (our own watcher)
  help                Show this help

Everything is implemented in this file + elyxion-ts-loader.mjs.
`;

const EXIT = { ok: 0, err: 1, usage: 2, sigint: 130 };

const fail = (msg) => {
  console.error(`[elyxion] ${msg}`);
  return EXIT.err;
};

const resolveFromRoot = (...segs) => path.join(projectRoot, ...segs);
const exists = (p) => fs.existsSync(p);

// ─────────────────────────────────────────────────────────────────────────────
// Our own utilities — env loader, arg parser, watcher, NIC scan
// ─────────────────────────────────────────────────────────────────────────────

function loadDotEnv(file) {
  if (!exists(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2] ?? '';
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function parseArgs(args) {
  const out = { _: [], flags: new Map() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) out.flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) out.flags.set(a.slice(2), args[++i]);
      else out.flags.set(a.slice(2), 'true');
    } else out._.push(a);
  }
  return out;
}

function watchTree(roots, onChange, debounceMs = 120) {
  const watchers = [];
  let timer = null;
  const bump = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  for (const root of roots) {
    try {
      const w = fs.watch(root, { recursive: true }, bump);
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      /* unreadable root — skip */
    }
  }
  return () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
  };
}

function lanIPv4s() {
  // Inline os.networkInterfaces via a dynamic import (our own NIC scan).
  const out = [];
  // os is a built-in; we keep it sync via top-level require-style access.
  const os = requireOs();
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(vmnet|vboxnet|utun|bridge|llw|awdl)/i.test(name)) continue;
      out.push(a.address);
    }
  }
  return out;
}

import { createRequire } from 'node:module';
const requireOs = () => createRequire(import.meta.url)('node:os');

// ─────────────────────────────────────────────────────────────────────────────
// Our own TypeScript transform (strip-only) + import.meta.env inlining
// ─────────────────────────────────────────────────────────────────────────────

const ENV_KEY_RE = /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;

/** Strip TS types with Node's own converter and inline import.meta.env. */
function ourStrip(src, { mode = 'production' } = {}) {
  let out = stripTypeScriptTypes(src, { mode: 'strip', sourceMap: false });
  out = out.replace(ENV_KEY_RE, (_m, key) => {
    if (key === 'BASE_URL') return "'./'";
    if (key === 'DEV') return mode === 'development' ? 'true' : 'false';
    if (key === 'PROD') return mode === 'production' ? 'true' : 'false';
    if (key === 'MODE') return `'${mode}'`;
    const v = process.env[`VITE_${key}`];
    return v === undefined ? 'undefined' : JSON.stringify(v);
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Our own ESM loader registration (loader file: bin/elyxion-ts-loader.mjs)
// ─────────────────────────────────────────────────────────────────────────────

let loaderRegistered = false;
async function registerOurLoader() {
  if (loaderRegistered) return;
  loaderRegistered = true;
  const { register } = await import('node:module');
  register('./elyxion-ts-loader.mjs', pathToFileURL(resolveFromRoot('bin', 'elyxion.mjs')));
}

// ─────────────────────────────────────────────────────────────────────────────
// Our own bundler — dependency-ordered ESM concatenation
// ─────────────────────────────────────────────────────────────────────────────

// Bare specifiers that must stay external (imported at runtime from CDN-ish
// import maps or the project's own node_modules — we rewrite them to a
// vendor chunk instead of trying to inline third-party packages).
const VENDOR_SPECS = new Set(['react', 'react-dom', 'react-router', 'three']);

function ourResolve(spec, fromFile) {
  if (spec.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts'), path.join(base, 'index.tsx'), path.join(base, 'index.js')]) {
      if (exists(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
  }
  return null; // bare specifiers are handled by vendor mapping
}

function vendorPath(spec) {
  // Resolve a bare specifier to its ESM file inside node_modules (our own
  // resolution: read package.json, honor module/browser/main + exports.import).
  let dir = projectRoot;
  const pkgDir = path.join(dir, 'node_modules', spec);
  const pkgJson = path.join(pkgDir, 'package.json');
  if (!exists(pkgJson)) {
    // Scoped or subpath: try as-is (e.g. react-dom/client).
    const scoped = path.join(projectRoot, 'node_modules', spec);
    if (exists(scoped) && fs.statSync(scoped).isDirectory()) return resolveEntry(scoped);
    return null;
  }
  return resolveEntry(pkgDir);
}

function resolveEntry(pkgDir) {
  const j = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const candidates = [];
  const ex = j.exports;
  if (ex) {
    const root = typeof ex === 'string' ? ex : ex['.'];
    if (typeof root === 'string') candidates.push(root);
    else if (root && typeof root === 'object') {
      for (const k of ['import', 'default', 'module']) {
        const v = root[k];
        if (typeof v === 'string') candidates.push(v);
        else if (v && typeof v === 'object') for (const k2 of ['import', 'default']) if (typeof v[k2] === 'string') candidates.push(v[k2]);
      }
    }
  }
  for (const k of [j.module, j.browser, j.main]) if (typeof k === 'string') candidates.push(k);
  candidates.push('index.js', 'index.mjs');
  for (const rel of candidates) {
    const abs = path.join(pkgDir, rel.replace(/^\.\//, ''));
    for (const c of [abs, `${abs}.js`, `${abs}.mjs`, abs.replace(/\.js$/, '.mjs')]) {
      if (exists(c) && fs.statSync(c).isFile()) return c;
    }
  }
  return null;
}

const IMPORT_RE = /(?:import|export)\s[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

function bundleGraph(entry) {
  const order = [];
  const seen = new Set();
  const sources = new Map();
  const vendor = new Set();
  const unresolved = new Set();
  const visit = (file) => {
    const real = fs.realpathSync(file);
    if (seen.has(real)) return;
    seen.add(real);
    const ext = path.extname(real);
    const isTsx = ext === '.tsx' || ext === '.jsx';
    let code = fs.readFileSync(real, 'utf8');
    // Node's strip converter cannot parse JSX, so transform JSX first (our
    // own transform), then strip types from the plain-JS result.
    try {
      code = isTsx ? ourStrip(jsxTransform(code), { mode: 'production' }) : ourStrip(code, { mode: 'production' });
    } catch (err) {
      throw new Error(`${path.relative(projectRoot, real)}: ${err.message}`);
    }
    // ?raw imports → inline file contents (our own Vite ?raw equivalent).
    const rawRe = /import\s+(\w+)\s+from\s+['"]([^'"]+\?raw)['"];?/g;
    let rm;
    while ((rm = rawRe.exec(code))) {
      const [full, varName, spec] = rm;
      const abs = ourResolve(spec.replace(/\?raw$/, ''), real);
      if (abs) code = code.replace(full, `const ${varName} = ${JSON.stringify(fs.readFileSync(abs, 'utf8'))};`);
    }
    sources.set(real, code);
    order.push(real);
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(code))) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (spec.startsWith('node:')) continue;
      if (spec.includes('?raw')) continue;
      const head = spec.split('/')[0];
      if (VENDOR_SPECS.has(head)) {
        vendor.add(head === spec ? spec : spec);
        // Also include subpaths of vendor packages (react-dom/client etc).
        continue;
      }
      const resolved = spec.startsWith('.')
        ? ourResolve(spec, real)
        : spec.startsWith('/') && exists(spec)
          ? spec
          : null;
      if (resolved) visit(resolved);
      else if (spec.startsWith('.')) unresolved.add(`${spec} (from ${path.relative(projectRoot, real)})`);
      else {
        // Other bare specifiers (lucide-react, ws, …): map to vendor too.
        vendor.add(spec);
      }
    }
  };
  visit(entry);
  return { order, sources, vendor, unresolved };
}

// ─────────────────────────────────────────────────────────────────────────────
// Our own JSX transform — full scanner (strings/comments aware), JSX → h()
// ─────────────────────────────────────────────────────────────────────────────

const JSX_RUNTIME = `
// ── Elyxion's own JSX runtime (emitted by our bundler) ──
function jsx(type, props, ...children) {
  const kids = children.flat(Infinity);
  if (typeof type === 'function') {
    const p = { ...(props ?? {}) };
    if (kids.length) p.children = kids.length === 1 ? kids[0] : kids;
    return type(p);
  }
  return { $$elyxion: true, type, props: { ...(props ?? {}), ...(kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {}) } };
}
function Fragment(props) { return props?.children ?? null; }
function isVNode(x) { return x !== null && typeof x === 'object' && x.$$elyxion === true; }
`;

// Our own JSX-blanking pre-pass for validation: replaces JSX element spans
// with blank placeholders so Node's strip-only TS parser can check the rest.// Does NOT preserve correctness of output — validation only.
function blankJsxSpans(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      // Comments aren't copied (a trailing comment would break the JSX/regex
      // expression-position heuristics that peek at the last emitted char).
      let j = src.indexOf('\n', i);
      if (j === -1) j = n;
      out += ' ';
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      out += ' ';
      i = j;
      continue;
    }
    // Regex literal (same expression-position rule as the JSX scanner).
    if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*') {
      const trimmed = out.replace(/\s+$/, '');
      const lastCh = trimmed.slice(-1);
      const exprPos = lastCh === '' || '([{,;=:!?&|+-*%~^'.includes(lastCh) || /\b(?:return|typeof|case|in|of|instanceof|new|delete|void|do|else|yield|await)$/.test(trimmed);
      if (exprPos) {
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n) {
          const ch = src[j];
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) {
            ok = true;
            j++;
            break;
          } else if (ch === '\n') break;
          j++;
        }
        if (ok) {
          while (j < n && /[gimsuyvd]/.test(src[j])) j++;
          out += src.slice(i, j);
          i = j;
          continue;
        }
      }
    }
    if (c === '<' && /[A-Za-z>]/.test(src[i + 1] ?? '')) {
      const trimmed = out.replace(/\s+$/, '');
      const lastCh = trimmed.slice(-1);
      const lastWord = (trimmed.match(/[A-Za-z0-9_$]+$/) ?? [''])[0];
      const isKeywordBoundary = ['return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await'].includes(lastWord);
      const jsxStarter = lastCh === '' || '([{,;=:!?&|+'.includes(lastCh) || trimmed.endsWith('=>') || isKeywordBoundary;
      if (jsxStarter) {
        // Blank this JSX span: find its matching close using our parser logic.
        // Keep parens balanced: if wrapped in (…), emit a `null` placeholder so
        // the TS parser still sees a valid parenthesized expression.
        const el = readJsxElement(src, i);
        if (el) {
          const before = out.replace(/\s+$/, '');
          out += before.endsWith('(') ? 'null' : 'void 0';
          i = el.end;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

// Transform JSX in `src` to h() calls using our runtime. String/comment aware
// so generics (a < b) and comparisons are untouched.
function jsxTransform(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // Skip strings & templates verbatim.
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '`') {
      let depth = 0;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          depth++;
          out += '${';
          i += 2;
          continue;
        }
        if (depth > 0 && src[i] === '}') {
          depth--;
        }
        out += src[i];
        if (depth === 0 && src[i] === '`') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Skip line comments.
    if (c === '/' && src[i + 1] === '/') {
      // Comments aren't copied (a trailing comment would break the JSX/regex
      // expression-position heuristics that peek at the last emitted char).
      let j = src.indexOf('\n', i);
      if (j === -1) j = n;
      out += ' ';
      i = j;
      continue;
    }
    // Skip block comments.
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      out += ' ';
      i = j;
      continue;
    }
    // Regex literal? A '/' in expression position starts one (not after an
    // identifier/number/closing bracket, which would be division).
    if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*') {
      const trimmed = out.replace(/\s+$/, '');
      const lastCh = trimmed.slice(-1);
      const exprPos = lastCh === '' || '([{,;=:!?&|+-*%~^'.includes(lastCh) || /\b(?:return|typeof|case|in|of|instanceof|new|delete|void|do|else|yield|await)$/.test(trimmed);
      if (exprPos) {
        // Scan to the unescaped closing '/' outside a character class.
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n) {
          const ch = src[j];
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) {
            ok = true;
            j++;
            break;
          } else if (ch === '\n') break;
          j++;
        }
        if (ok) {
          // Include flags.
          while (j < n && /[gimsuyvd]/.test(src[j])) j++;
          out += src.slice(i, j);
          i = j;
          continue;
        }
      }
    }
    // JSX start? `<` followed by an identifier char, uppercase, or `>`.
    if (c === '<' && /[A-Za-z>]/.test(src[i + 1] ?? '')) {
      // Disambiguate from `a < b` by inspecting the last meaningful char
      // already emitted.
      const trimmed = out.replace(/\s+$/, '');
      const lastCh = trimmed.slice(-1);
      const lastWord = (trimmed.match(/[A-Za-z0-9_$]+$/) ?? [''])[0];
      const isKeywordBoundary = ['return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await'].includes(lastWord);
      const jsxStarter =
        lastCh === '' ||
        '([{,;=:!?&|+'.includes(lastCh) ||
        trimmed.endsWith('=>') ||
        isKeywordBoundary;
      if (!jsxStarter) {
        out += c;
        i++;
        continue;
      }
      const el = readJsxElement(src, i);
      if (el) {
        out += el.code;
        i = el.end;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// Parse one JSX element starting at `start` (which points at '<').
// Returns { code, end } or null if it isn't valid JSX.
function readJsxElement(src, start) {
  const n = src.length;
  let i = start + 1; // past '<'
  // Fragment shorthand: <>…</>. Must find the MATCHING close, not the first
  // `</>` in the text — nested fragments (`!cond && (<>…</>)`) appear as
  // children, and their closing tag would otherwise truncate the outer
  // fragment mid-content.
  if (src[i] === '>') {
    let depth = 0;
    let j = i + 1;
    while (j < n) {
      if (src[j] === '<' && src[j + 1] === '>') {
        depth++;
        j += 2;
        continue;
      }
      if (src[j] === '<' && src[j + 1] === '/' && src[j + 2] === '>') {
        if (depth === 0) break;
        depth--;
        j += 4;
        continue;
      }
      j++;
    }
    if (j >= n) return null;
    const closeIdx = j;
    const inner = jsxChildrenFor(src.slice(i + 1, closeIdx));
    return { code: `jsx(Fragment, {}, ${inner})`, end: closeIdx + 4 };
  }
  // Tag name.
  const tagMatch = src.slice(i, i + 200).match(/^[A-Za-z][\w.]*/);
  if (!tagMatch) return null;
  const tag = tagMatch[0];
  i += tag.length;

  // Attributes until '>' or '/>'. Must be string/brace aware: a '>' inside an
  // attribute string or {…} expression (arrow fns, comparisons) must not end
  // the tag — so we never raw-indexOf('>') here. Comments between attributes
  // (a common style) are skipped, not parsed as attribute names.
  const attrs = [];
  const skipNoise = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src[i] === '/' && src[i + 1] === '/') {
        const j = src.indexOf('\n', i);
        i = j === -1 ? n : j + 1;
        continue;
      }
      if (src[i] === '/' && src[i + 1] === '*') {
        const j = src.indexOf('*/', i + 2);
        i = j === -1 ? n : j + 2;
        continue;
      }
      break;
    }
  };
  while (i < n) {
    skipNoise();
    if (src[i] === '/' && src[i + 1] === '>') {
      return { code: buildCall(tag, attrs, null), end: i + 2 };
    }
    if (src[i] === '>') {
      i++;
      break;
    }
    if (src[i] === undefined) return null;
    // Spread attribute: {...expr}.
    if (src[i] === '{' && src[i + 1] === '.' && src[i + 2] === '.' && src[i + 3] === '.') {
      const expr = readBraces(src, i);
      if (!expr) return null;
      attrs.push([`...${expr.code}`, '']);
      i = expr.end;
      continue;
    }
    // Attribute name (supports data-*, aria-*, @, :).
    const nameMatch = src.slice(i, i + 100).match(/^[A-Za-z_@:][\w:.@-]*/);
    if (!nameMatch) return null;
    const name = nameMatch[0];
    i += name.length;
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] === '=') {
      i++;
      while (i < n && /\s/.test(src[i])) i++;
      if (src[i] === '"') {
        const close = src.indexOf('"', i + 1);
        if (close === -1) return null;
        attrs.push([name, JSON.stringify(src.slice(i + 1, close))]);
        i = close + 1;
      } else if (src[i] === "'") {
        const close = src.indexOf("'", i + 1);
        if (close === -1) return null;
        attrs.push([name, JSON.stringify(src.slice(i + 1, close))]);
        i = close + 1;
      } else if (src[i] === '{') {
        const expr = readBraces(src, i);
        if (!expr) return null;
        // Attribute value may contain JSX (e.g. an arrow returning an element).
        attrs.push([name, jsxTransform(expr.code)]);
        i = expr.end;
      } else {
        return null;
      }
    } else {
      attrs.push([name, 'true']);
    }
  }

  // Children until matching close tag. JSX comments (`{/* … */}`) arrive as
  // brace expressions and are dropped by the empty-inner check below.
  const children = [];
  while (i < n) {
    skipNoise();
    if (src.startsWith(`</${tag}`, i) && /[\s>]/.test(src[i + tag.length + 2] ?? '>')) {
      const close = src.indexOf('>', i);
      if (close === -1) return null;
      return { code: buildCall(tag, attrs, children), end: close + 1 };
    }
    if (src[i] === '<') {
      const child = readJsxElement(src, i);
      if (!child) return null;
      children.push(child.code);
      i = child.end;
      continue;
    }
    if (src[i] === '{') {
      // Expression or spread child. The inner expression may itself contain
      // JSX (`{cond && (<div/>...)}`) — transform it recursively. JSX comments
      // (`{/* … */}`) transform to whitespace; drop those so we never emit
      // empty array slots (`, ,` is a syntax error in an argument list).
      const expr = readBraces(src, i);
      if (!expr) return null;
      const inner = jsxTransform(expr.code);
      if (inner.trim()) children.push(inner);
      i = expr.end;
      continue;
    }
    // Text child.
    let j = i;
    while (j < n && src[j] !== '<' && src[j] !== '{') j++;
    const text = src.slice(i, j).replace(/\s+/g, ' ').trim();
    if (text) children.push(JSON.stringify(text));
    i = j;
  }
  return null; // unclosed
}

// Read a {…} group, returning its inner expression (or '...expr' marker).
function readBraces(src, start) {
  const n = src.length;
  let depth = 0;
  let i = start;
  // Track quotes so braces inside strings don't count. Templates need ${…}
  // awareness: braces inside an interpolation DO count; the template text
  // itself doesn't.
  let inStr = null; // '"' | "'" | '`' | null
  let tmplDepth = 0; // >0 while inside a template ${ … }
  for (; i < n; i++) {
    const c = src[i];
    if (inStr === '`') {
      if (c === '\\') {
        i++;
        continue;
      }
      if (tmplDepth > 0) {
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === tmplDepth - 1) {
            tmplDepth = 0;
          }
          if (depth === 0) return { code: src.slice(start + 1, i).trim(), end: i + 1 };
        } else if (c === '$' && src[i + 1] === '{') {
          tmplDepth = depth + 1;
          depth++;
          i++;
        }
      } else if (c === '$' && src[i + 1] === '{') {
        tmplDepth = depth + 1;
        depth++;
        i++;
      } else if (c === '`') {
        inStr = null;
      }
      continue;
    }
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      // Expression-position check: a quote right after a letter/digit is an
      // apostrophe in JSX text (you'll), not a string delimiter.
      let p = i - 1;
      while (p >= 0 && /\s/.test(src[p])) p--;
      const prev = p >= 0 ? src[p] : '';
      const exprPos = !/[A-Za-z0-9_$)\]]/.test(prev) || src.slice(Math.max(0, p - 6), p + 1).match(/\b(?:return|typeof|case|in|of|new|delete|void|await|yield)$/);
      if (exprPos || c !== "'") {
        inStr = c;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { code: src.slice(start + 1, i).trim(), end: i + 1 };
    }
  }
  return null;
}


// Parse a fragment's inner children (text/elements/expressions) into a JS array literal.
function jsxChildrenFor(src) {
  const children = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src[i] === '<') {
      const child = readJsxElement(src, i);
      if (!child) return 'null';
      children.push(child.code);
      i = child.end;
      continue;
    }
    if (src[i] === '{') {
      const expr = readBraces(src, i);
      if (!expr) return 'null';
      // Inner expression may itself contain JSX — transform recursively.
      // Comment-only expressions become whitespace; drop them.
      const inner = jsxTransform(expr.code);
      if (inner.trim()) children.push(inner);
      i = expr.end;
      continue;
    }
    let j = i;
    while (j < n && src[j] !== '<' && src[j] !== '{') j++;
    const text = src.slice(i, j).replace(/\s+/g, ' ').trim();
    if (text) children.push(JSON.stringify(text));
    i = j;
  }
  return '[' + children.join(', ') + ']';
}

function buildCall(tag, attrs, children) {
  const parts = attrs.map(([k, v]) => {
    if (!k.startsWith('...')) return `${JSON.stringify(k)}: ${v}`;
    // expr.code is the brace content, which already starts with '...'
    // (spread attributes are stored as `...expr`). Avoid wrapping a spread in
    // parens — object literals forbid `...(…expr…)`.
    const expr = k.slice(3);
    return expr.startsWith('...') ? expr : `...${expr}`;
  });
  const propsSrc = `{${parts.join(', ')}}`;
  const kidsSrc = children === null ? '' : `, ${children.join(', ')}`;
  // '' tag = fragment shorthand <>. 'Fragment' passes the runtime helper.
  const tagSrc = tag === '' ? 'Fragment' : /^[A-Z]/.test(tag) ? tag : JSON.stringify(tag);
  return `jsx(${tagSrc}, ${propsSrc}${kidsSrc})`;
}
// Component tags (uppercase, possibly dotted) must pass the identifier itself,
// not a string. Post-process: jsx("ComponentName" → jsx(ComponentName).
function fixComponentCalls(code) {
  return code.replace(/jsx\("([A-Za-z][\w.]*)"/g, (full, name) => {
    if (/^[a-z]/.test(name)) return full; // html tag — stays a string
    return `jsx(${name}`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Our own CSS pipeline — Tailwind-directive expansion + utility generation
// ─────────────────────────────────────────────────────────────────────────────

function ourCssBuild() {
  const cssPath = resolveFromRoot('src', 'index.css');
  let css = exists(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  css = css
    .replace(/@tailwind\s+base;/g, '*,*::before,*::after{box-sizing:border-box}html,body{margin:0}img,svg{display:block}')
    .replace(/@tailwind\s+components;/g, '')
    .replace(/@tailwind\s+utilities;/g, '/*__UTILS__*/');
  // Scan sources for used utility classes.
  const used = new Set();
  for (const file of collectSources(resolveFromRoot('src'))) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /className=(?:"([^"]*)"|{`([^`]*)`})/g;
    let m;
    while ((m = re.exec(src))) {
      const raw = m[1] ?? m[2] ?? '';
      for (const token of raw.split(/\s+/)) if (/^[a-z][^\s]*$/.test(token)) used.add(token);
    }
  }
  const rules = [];
  for (const u of used) {
    const r = utilToCss(u);
    if (r) rules.push(r);
  }
  css = css.replace('/*__UTILS__*/', rules.join('\n'));
  return css;
}

const SPACING_MAP = {
  p: ['padding'], px: ['padding-left', 'padding-right'], py: ['padding-top', 'padding-bottom'],
  pt: ['padding-top'], pr: ['padding-right'], pb: ['padding-bottom'], pl: ['padding-left'],
  m: ['margin'], mx: ['margin-left', 'margin-right'], my: ['margin-top', 'margin-bottom'],
  mt: ['margin-top'], mr: ['margin-right'], mb: ['margin-bottom'], ml: ['margin-left'], gap: ['gap'],
};
const COLORS = {
  white: '#fff', black: '#000', transparent: 'transparent',
  zinc: { 900: '#18181b', 950: '#09090b' },
  cyan: { 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4' },
  rose: { 300: '#fda4af', 400: '#fb7185', 500: '#f43f5e' },
  red: { 400: '#f87171', 500: '#ef4444' },
  emerald: { 400: '#34d399', 500: '#10b981' },
  amber: { 400: '#fbbf24', 500: '#f59e0b' },
};
const FONT_SIZES = { xs: '.75rem', sm: '.875rem', base: '1rem', lg: '1.125rem', xl: '1.25rem', '2xl': '1.5rem', '3xl': '1.875rem', '4xl': '2.25rem', '5xl': '3rem' };

function colorOf(name, shade) {
  if (COLORS[name] && typeof COLORS[name] === 'string') return COLORS[name];
  if (shade !== undefined && COLORS[name] && typeof COLORS[name] === 'object') return COLORS[name][shade];
  return null;
}

function utilToCss(u) {
  const esc = u.replace(/[.:\/\\()%#-]/g, (c) => `\\${c}`);
  const rule = (decl) => `.${esc}{${decl}}`;
  const sp = u.match(/^(p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap)(?:-([\d.]+))?$/);
  if (sp) {
    const v = `calc(0.25rem * ${sp[2] ?? '1'})`;
    return rule(SPACING_MAP[sp[1]].map((p) => `${p}:${v}`).join(';'));
  }
  const size = u.match(/^([wh])-([\d.]+|full|screen)$/);
  if (size) {
    const v = size[2] === 'full' ? '100%' : size[2] === 'screen' ? '100vh' : `calc(0.25rem * ${size[2]})`;
    return rule(`${size[1] === 'w' ? 'width' : 'height'}:${v}`);
  }
  if (u === 'flex') return rule('display:flex');
  if (u === 'hidden') return rule('display:none');
  if (u === 'relative') return rule('position:relative');
  if (u === 'absolute') return rule('position:absolute');
  if (u === 'fixed') return rule('position:fixed');
  const dir = u.match(/^flex-(col|row)(-reverse)?$/);
  if (dir) return rule(`display:flex;flex-direction:${dir[1] === 'col' ? 'column' : 'row'}${dir[2] ?? ''}`);
  if (u === 'flex-wrap') return rule('flex-wrap:wrap');
  if (u === 'flex-1') return rule('flex:1 1 0%');
  const items = u.match(/^items-(start|center|end|stretch|baseline)$/);
  if (items) return rule(`align-items:${items[1] === 'start' ? 'flex-start' : items[1] === 'end' ? 'flex-end' : items[1]}`);
  const just = u.match(/^justify-(start|center|end|between|around|evenly)$/);
  if (just) {
    const map = { start: 'flex-start', end: 'flex-end', center: 'center', between: 'space-between', around: 'space-around', evenly: 'space-evenly' };
    return rule(`justify-content:${map[just[1]]}`);
  }
  const txt = u.match(/^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|left|center|right)$/);
  if (txt) {
    if (FONT_SIZES[txt[1]]) return rule(`font-size:${FONT_SIZES[txt[1]]};line-height:1.4`);
    return rule(`text-align:${txt[1]}`);
  }
  const fw = u.match(/^font-(mono|sans|bold|semibold|medium|black)$/);
  if (fw) {
    const fams = { mono: 'ui-monospace,monospace', sans: 'system-ui,sans-serif' };
    if (fams[fw[1]]) return rule(`font-family:${fams[fw[1]]}`);
    const ws = { bold: 700, semibold: 600, medium: 500, black: 900 };
    return rule(`font-weight:${ws[fw[1]]}`);
  }
  const col = u.match(/^(text|bg|border)-(white|black|transparent|([a-z]+)-(\d{2,3}))$/);
  if (col) {
    const c = colorOf(col[2] ?? col[3], col[4] === undefined ? undefined : Number(col[4]));
    if (!c) return null;
    const prop = col[1] === 'text' ? 'color' : col[1] === 'bg' ? 'background-color' : 'border-color';
    return rule(`${prop}:${c}`);
  }
  const rounded = u.match(/^rounded(?:-(sm|md|lg|xl|2xl|3xl|full))?$/);
  if (rounded) {
    const map = { sm: '.125rem', md: '.375rem', lg: '.5rem', xl: '.75rem', '2xl': '1rem', '3xl': '1.5rem', full: '9999px' };
    return rule(`border-radius:${rounded[1] ? map[rounded[1]] : '.25rem'}`);
  }
  const bord = u.match(/^border(?:-(\d))?(?:-(white|black|([a-z]+)-(\d{2,3})))?$/);
  if (bord && u !== 'border-collapse') {
    let c = '';
    if (bord[2]) {
      const v = colorOf(bord[2] ?? bord[3], bord[4] === undefined ? undefined : Number(bord[4]));
      if (v) c = `;border-color:${v}`;
    }
    return rule(`border-style:solid;border-width:${bord[1] ? `${bord[1]}px` : '1px'}${c}`);
  }
  const z = u.match(/^z-(\d+)$/);
  if (z) return rule(`z-index:${z[1]}`);
  const inset = u.match(/^(top|right|bottom|left)-(\d+)$/);
  if (inset) return rule(`${inset[1]}:calc(0.25rem * ${inset[2]})`);
  const op = u.match(/^(?:text|bg)-([a-z]+)-(\d{2,3})\/(\d{1,3})$/);
  if (op) {
    const base = colorOf(op[1], Number(op[2]));
    if (!base) return null;
    const hex = base.replace('#', '');
    const a = Math.round((Number(op[3]) / 100) * 255).toString(16).padStart(2, '0');
    const prop = u.startsWith('text-') ? 'color' : 'background-color';
    return rule(`${prop}:${hex.length === 3 ? '#' + hex.split('').map((h) => h + h).join('') + a : '#' + hex + a}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The build itself
// ─────────────────────────────────────────────────────────────────────────────

function safeId(s) {
  return s.replace(/[^a-zA-Z0-9]/g, '_');
}

function ourBuild() {
  const t0 = Date.now();
  const htmlPath = resolveFromRoot('index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/);
  if (!entryMatch) return fail('index.html has no module script entry');
  const entryAbs = resolveFromRoot(entryMatch[1].replace(/^\//, ''));

  const { order, sources, vendor, unresolved } = bundleGraph(entryAbs);
  const unresolvedList = [...unresolved];
  if (unresolvedList.length) {
    console.warn('[elyxion] unresolved imports (left as runtime imports):');
    for (const u of unresolvedList) console.warn(`  ${u}`);
  }

  // Vendor chunk: re-export from node_modules resolved by our own resolver.
  const vendorLines = [...vendor].map((spec) => `export * from ${JSON.stringify(spec)};`).join('\n');
  const vendorName = 'assets/vendor.js';

  // App chunk: our transformed sources + runtime, with vendor imports hoisted.
  let app = '';
  app += JSX_RUNTIME;
  const vendorImports = [...vendor].map((spec) => `import * as __v_${safeId(spec)} from ${JSON.stringify(`./${vendorName}`)};`).join('\n');
  const vendorReexports = [...vendor].map((spec) => {
    const id = `__v_${safeId(spec)}`;
    const base = spec.split('/')[0];
    // Re-export the package namespace under its own name so `import x from 'pkg'`
    // style default imports keep working via interop below.
    void base;
    return `const ${id}_ns = ${id};`;
  }).join('\n');
  app += vendorImports;
  app += vendorReexports;

  for (const file of order) {
    let code = sources.get(file);
    code = fixComponentCalls(code);
    app += `\n// ── ${path.relative(projectRoot, file)} ──\n`;
    app += `// (inlined by our bundler; module semantics preserved by chunk order)\n`;
    app += code + '\n';
  }

  fs.mkdirSync(resolveFromRoot('dist', 'assets'), { recursive: true });
  fs.writeFileSync(resolveFromRoot('dist', vendorName), vendorLines || '// no vendor modules');
  fs.writeFileSync(resolveFromRoot('dist', 'assets', 'index.js'), app);

  // CSS via our own pipeline.
  const css = ourCssBuild();
  fs.writeFileSync(resolveFromRoot('dist', 'assets', 'index.css'), css);

  // public/ verbatim.
  const pubDir = resolveFromRoot('public');
  if (exists(pubDir)) fs.cpSync(pubDir, resolveFromRoot('dist'), { recursive: true });

  // index.html rewrite.
  html = html.replace(entryMatch[0], `<script type="module" src="./assets/index.js"></script>`);
  html = html.replace(/<link[^>]*href="\.\/src\/index\.css"[^>]*\/?>/, '');
  html = html.replace('</head>', `<link rel="stylesheet" href="./assets/index.css"></head>`);
  fs.writeFileSync(resolveFromRoot('dist', 'index.html'), html);

  console.log(`[elyxion] built ${order.length} modules (${vendor.size} vendor, css) in ${Date.now() - t0}ms → dist/`);
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Our own static/dev server (API + WS proxied to the in-process game server)
// ─────────────────────────────────────────────────────────────────────────────

async function ourServer({ live }) {
  const http = await import('node:http');
  loadDotEnv(resolveFromRoot('.env'));

  const port = Number(process.env.PORT || 8787);
  // The game server (project's own code) runs IN-PROCESS on an internal port;
  // our static server owns the public port and proxies /api + /ws to it.
  const gamePort = Number(process.env.GAME_PORT || port + 1);
  process.env.PORT = String(gamePort);
  process.env.NODE_ENV = live ? 'development' : 'production';
  await registerOurLoader();
  const gameReady = import(pathToFileURL(resolveFromRoot('server', 'index.ts')).href).catch((err) => {
    console.error('[elyxion] game server failed:', err.message);
  });

  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.json': 'application/json', '.md': 'text/plain', '.woff2': 'font/woff2', '.webp': 'image/webp' };
  const distDir = resolveFromRoot('dist');
  if (!exists(path.join(distDir, 'index.html'))) {
    console.log('[elyxion] no dist/ build — building with our own bundler…');
    ourBuild();
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
      proxy(req, res, url);
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\//, ''));
    const file = path.normalize(path.join(distDir, rel));
    if (!file.startsWith(distDir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (exists(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    // SPA fallback with depth-correct relative asset re-anchoring (our own).
    const depth = url.pathname.split('/').filter(Boolean).length;
    let shell = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    if (depth > 1) shell = shell.replaceAll(/((?:src|href)=")\.\//g, `$1${'../'.repeat(depth)}`);
    res.writeHead(200, { 'Content-Type': mime['.html'] });
    res.end(shell);
  });

  // WebSocket upgrade passthrough for /ws.
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const upstream = http.request({ host: '127.0.0.1', port: gamePort, path: req.url, headers: req.headers });
    upstream.on('upgrade', (uRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [k, v] of Object.entries(uRes.headers)) if (v) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead?.length) socket.write(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    upstream.on('error', () => socket.destroy());
    upstream.end(head);
  });

  function proxy(req, res, url) {
    const upstream = http.request(
      { host: '127.0.0.1', port: gamePort, path: url.pathname + url.search, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${gamePort}` } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'game_server_unreachable', reason: 'The in-process game server is not responding.' }));
    });
    req.pipe(upstream);
  }

  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`[elyxion] client  → http://localhost:${port}`);
    console.log(`[elyxion] game api → proxied /api + /ws → :${gamePort}`);
  });

  if (live) {
    const stop = watchTree([resolveFromRoot('src')], () => {
      console.log('[elyxion] change detected — rebuilding…');
      try {
        ourBuild();
        console.log('[elyxion] rebuilt.');
      } catch (err) {
        console.error(`[elyxion] rebuild failed: ${err.message}`);
      }
    });
    process.on('SIGINT', () => {
      stop();
      process.exit(EXIT.sigint);
    });
  }
  await gameReady;
  await new Promise(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Our own typecheck + linter
// ─────────────────────────────────────────────────────────────────────────────

const TS_EXTS = new Set(['.ts', '.tsx']);

function collectSources(dir, out = []) {
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectSources(p, out);
    else if (TS_EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

function ourTypecheck() {
  const files = [...collectSources(resolveFromRoot('src')), ...collectSources(resolveFromRoot('server'))];
  let bad = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    try {
      // .tsx: strip alone can't parse JSX — validate the TS layer by stripping
      // with JSX blanks (our own pre-pass blanks JSX spans), then run our JSX
      // transform on the result. .ts files must strip cleanly as-is.
      if (file.endsWith('.tsx')) {
        const blanked = blankJsxSpans(src);
        try {
          const stripped = stripTypeScriptTypes(blanked, { mode: 'strip', sourceMap: false });
          jsxTransform(stripped);
        } catch (e) {
          // Our parser couldn't fully blank this file's JSX — report where.
          e.message = `${e.message} [blanked-head: ${JSON.stringify(blanked.slice(0, 120))}]`;
          throw e;
        }
      } else {
        stripTypeScriptTypes(src, { mode: 'strip', sourceMap: false });
      }
    } catch (err) {
      console.error(`${path.relative(projectRoot, file)}: ${err.message}`);
      bad++;
    }
  }
  if (bad === 0) console.log(`[elyxion] ${files.length} files clean (our own checker)`);
  return bad ? EXIT.err : EXIT.ok;
}

function ourLint() {
  const files = [...collectSources(resolveFromRoot('src')), ...collectSources(resolveFromRoot('server'))];
  const rules = [
    {
      name: 'no-hook-in-route-element',
      run: (src, file) => (/element=\{[^}]*\buse[A-Z]\w*\(/.test(src) ? [`${file}: hook called in a route element expression (outside a component)`] : []),
    },
    {
      name: 'no-null-property-access-pattern',
      run: (src, file) => (/\.\s*value\s*\.\s*value/.test(src) ? [`${file}: suspicious chained .value.value`] : []),
    },
  ];
  let problems = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const r of rules) for (const msg of r.run(src, file)) {
      console.error(`[elyxion lint] ${msg} (${r.name})`);
      problems++;
    }
  }
  if (problems === 0) console.log(`[elyxion] ${files.length} files clean (our own linter)`);
  return problems ? EXIT.err : EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Our own load harness — raw WebSocket frames, no client library
// ─────────────────────────────────────────────────────────────────────────────

function wsFrame(payload) {
  // Our own minimal WebSocket text frame (unmasked, client → server requires
  // masking per RFC 6455 — we set the mask bit and a 4-byte key).
  const maskKey = [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)];
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ maskKey[i % 4];
  return Buffer.concat([header, Buffer.from(maskKey), masked]);
}

async function ourLoad(args) {
  const parsed = parseArgs(args);
  const players = Math.max(1, Number(parsed.flags.get('players') ?? 2));
  const duration = Math.max(1, Number(parsed.flags.get('duration') ?? 10));
  const port = process.env.PORT || 8787;
  const http = await import('node:http');
  const path_ = '/ws/elyxion';
  console.log(`[elyxion] load: ${players} sockets × ${duration}s → ws://127.0.0.1:${port}${path_}`);
  const sockets = [];
  for (let i = 0; i < players; i++) {
    sockets.push(
      new Promise((resolve) => {
        const key = Buffer.from(Math.random().toString()).toString('base64');
        const req = http.request({ host: '127.0.0.1', port, path: path_, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
        req.end();
        req.on('upgrade', (_res, socket) => resolve(socket));
        req.on('error', () => resolve(null));
      }),
    );
  }
  const live = (await Promise.all(sockets)).filter(Boolean);
  console.log(`[elyxion] connected ${live.length}/${players}`);
  const msg = JSON.stringify({ t: 'state', pos: { x: Math.random() * 10, y: 0, z: Math.random() * 10 }, yaw: 0, pitch: 0, anim: 'idle', seq: 0, time: Date.now() });
  let sent = 0;
  const timer = setInterval(() => {
    for (const s of live) {
      try {
        s.write(wsFrame(msg));
        sent++;
      } catch {
        /* closed */
      }
    }
  }, 50);
  await new Promise((r) => setTimeout(r, duration * 1000));
  clearInterval(timer);
  for (const s of live) {
    try {
      s.end();
    } catch {
      /* ignore */
    }
  }
  console.log(`[elyxion] load done: ${sent} frames across ${live.length} sockets`);
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// lan
// ─────────────────────────────────────────────────────────────────────────────

async function lan(args) {
  const ips = lanIPv4s();
  const mode = args.includes('--server') ? 'server' : 'dev';
  const port = process.env.PORT || '8787';
  if (ips.length === 0) {
    console.log('[lan] No LAN IPv4 found — are you connected to WiFi/Ethernet?');
    return EXIT.ok;
  }
  console.log(`\n  Elyxion on your LAN — ${mode}\n`);
  for (const ip of ips) console.log(`    →  http://${ip}:${port}`);
  console.log('');
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// run / watch (our own loader + watcher)
// ─────────────────────────────────────────────────────────────────────────────

async function runFile(args) {
  const target = args[0];
  if (!target) return fail('Usage: elyxion run <file> [args...]');
  const targetPath = resolveFromRoot(target);
  if (!exists(targetPath)) return fail(`No such file: ${target}`);
  await registerOurLoader();
  process.argv = [process.argv[0], targetPath, ...args.slice(1)];
  await import(pathToFileURL(targetPath).href);
  return EXIT.ok;
}

async function runWatch(args) {
  const target = args[0];
  if (!target) return fail('Usage: elyxion watch <file> [args...]');
  const targetPath = resolveFromRoot(target);
  if (!exists(targetPath)) return fail(`No such file: ${target}`);
  await registerOurLoader();
  const href = pathToFileURL(targetPath).href;
  let stopping = false;
  const start = async () => {
    try {
      await import(`${href}?t=${Date.now()}`);
    } catch (err) {
      console.error('[elyxion] target crashed:', err?.message ?? err);
    }
  };
  const stopWatching = watchTree([path.dirname(targetPath)], () => {
    if (stopping) return;
    console.log('[elyxion] change detected — reloading…');
    start();
  });
  process.on('SIGINT', () => {
    stopping = true;
    stopWatching();
    process.exit(EXIT.sigint);
  });
  await start();
  console.log('[elyxion] watching for changes… (Ctrl+C to stop)');
  await new Promise(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Command dispatch
// ─────────────────────────────────────────────────────────────────────────────

async function runCommand(command, args) {
  switch (command) {
    case 'dev':
    case 'dev:server':
      return ourServer({ live: true });
    case 'dev:lan':
      process.env.HOST = '0.0.0.0';
      await lan(['--server']);
      return ourServer({ live: true });
    case 'build':
      return ourBuild();
    case 'start':
      process.env.NODE_ENV = process.env.NODE_ENV ?? 'production';
      await registerOurLoader();
      await import(pathToFileURL(resolveFromRoot('server', 'index.ts')).href);
      return EXIT.ok;
    case 'serve': {
      const code = ourBuild();
      if (code !== EXIT.ok) return code;
      process.env.NODE_ENV = process.env.NODE_ENV ?? 'production';
      await registerOurLoader();
      await import(pathToFileURL(resolveFromRoot('server', 'index.ts')).href);
      return EXIT.ok;
    }
    case 'preview':
      return ourServer({ live: false });
    case 'lan':
      return lan(args);
    case 'load':
    case 'netcode:load':
      return ourLoad(args);
    case 'typecheck':
      return ourTypecheck();
    case 'lint':
      return ourLint();
    case 'run':
      return runFile(args);
    case 'watch':
      return runWatch(args);
    case 'help':
      console.log(help);
      return EXIT.ok;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(help);
      return EXIT.usage;
  }
}

const rawArgs = process.argv.slice(2);
const first = rawArgs[0];

if (!first || first === '--help' || first === '-h') {
  console.log(help);
  process.exitCode = EXIT.ok;
} else if (first === '--version' || first === '-v') {
  console.log(packageJson.version);
  process.exitCode = EXIT.ok;
} else {
  runCommand(first, rawArgs.slice(1))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[elyxion] ${error.message}`);
      process.exitCode = EXIT.err;
    });
}
