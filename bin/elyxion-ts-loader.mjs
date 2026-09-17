// Elyxion CLI — our own TypeScript ESM loader (used by `run`, `watch`, `start`).
//
// This is the CLI's own loader built on Node's supported `module.register`
// hooks. It does three things, all with Node built-ins:
//   1. `.ts→.js` specifier fallback (the TS ESM idiom `./x.js` → `./x.ts`).
//   2. Strips TypeScript types from `.ts` sources using Node's own
//      strip-only converter (no external compiler).
//   3. Inlines `import.meta.env.*` lookups the way our bundler does.
//
// .tsx is NOT executed by this loader — JSX needs the full browser transform,
// which is our bundler's job. Server and script files are plain .ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const TS_EXTS = new Set(['.ts', '.mts', '.cts']);
const ENV_KEY_RE = /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Our .ts→.js fallback: `import './x.js'` also tries `./x.ts`.
    if (specifier.endsWith('.js') && context.parentURL) {
      try {
        return await nextResolve(specifier.replace(/\.js$/, '.ts'), context);
      } catch {
        /* fall through to the original error */
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  let p;
  try {
    p = fileURLToPath(url);
  } catch {
    return nextLoad(url, context);
  }
  const ext = p.slice(p.lastIndexOf('.'));
  if (TS_EXTS.has(ext)) {
    const src = readFileSync(p, 'utf8');
    let out;
    try {
      out = stripTypeScriptTypes(src, { mode: 'strip', sourceMap: false });
    } catch (err) {
      throw new Error(`${p}: ${err.message}`);
    }
    out = out.replace(ENV_KEY_RE, (_m, key) => {
      if (key === 'BASE_URL') return "'./'";
      if (key === 'DEV') return 'false';
      if (key === 'PROD') return 'true';
      if (key === 'MODE') return "'production'";
      return 'undefined';
    });
    return { format: 'module', source: out, shortCircuit: true };
  }
  return nextLoad(url, context);
}
