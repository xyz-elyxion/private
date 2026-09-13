// PostgreSQL backend for the Elyxion data layer.
//
// server/db.ts is written against better-sqlite3's synchronous API (~130
// prepared statements: .get/.all/.run + .changes/.lastInsertRowid, named `@x`
// parameters, sqlite-typed DDL). When a PostgreSQL URL env var is present
// (DATABASE_URL / POSTGRES_URL / POSTGRESQL_URL), this module supplies a
// drop-in replacement that speaks the same Database/Statement surface but runs
// everything on PostgreSQL through node-postgres. Rewriting all of db.ts
// per-backend would fork the game's data layer into two drift-prone copies.
//
// Synchronous facade: better-sqlite3 is sync and the entire data layer leans
// on that (no async plumbing anywhere). We keep the contract with a dedicated
// worker thread: each call posts {sql, values} to the worker, which awaits the
// pg Pool and blocks the calling thread via SharedArrayBuffer + Atomics.wait
// until the result is back. This layer only serves stats/accounts/admin data
// around match boundaries — never the 64 Hz game loop (see server/elyxion-
// game.ts), so a blocking round-trip (sub-ms on LAN, few ms on managed PG) is
// acceptable.
//
// Translation (sqlite → postgres), applied at prepare/exec time:
//   INTEGER PRIMARY KEY AUTOINCREMENT → BIGINT GENERATED ALWAYS AS IDENTITY
//   BLOB → bytea
//   INSERT OR IGNORE INTO … → INSERT INTO … ON CONFLICT DO NOTHING
//     (constraints stay in the DDL, so ON CONFLICT DO NOTHING catches them)
//   scalar max(a,b)/min(a,b) → GREATEST(a,b)/LEAST(a,b)
//     (aggregates like MAX(progress) are untouched — only 2-arg calls in
//     upsert SET clauses ever appear as bare max(/min( in this codebase)
//   MIN(goal, …)/MAX(progress, …) 2-arg forms inside ON CONFLICT SET → LEAST/GREATEST
//   CAST(x AS INTEGER) → unchanged (valid PG; integer division semantics differ
//     only for float inputs — ts/DAY_MS paths are exact)
//   ? → $1..$n   ·   @named → $n by first appearance
//   sqlite_master probes → pg_catalog equivalents (same row shapes)
//   PRAGMA table_info(t) → information_schema.columns (same {name} shape)
//   sqlite.pragma(...) → no-op (WAL/busy_timeout have no PG analogue; pooling
//     covers durability/latency)
//
// Types map 1:1 for this schema: TEXT↔text, INTEGER↔bigint (returned as a
// string by node-postgres — coerced back via the NUMERIC_COLS allowlist),
// REAL↔double precision, BLOB↔bytea (Buffer both ways).

import path from 'node:path';
import { Worker } from 'node:worker_threads';

export type PgConfig = { url: string };

export function resolvePgConfig(): PgConfig | null {
  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRESQL_URL ||
    '';
  if (!url) return null;
  // Only treat postgres:// URLs as PG. A DATABASE_PATH-style file path means
  // "use sqlite" (the default backend).
  if (!/^postgres(ql)?:\/\//i.test(url)) return null;
  return { url };
}

// ── Worker bridge ────────────────────────────────────────────────────────────
//
// One worker owns the pg Pool (connections are not thread-safe to share).
// Callers block with Atomics.wait. postMessage cannot participate in that:
// the host's 'message' handler is an event-loop task and never runs while the
// calling thread is blocked, so both the SIGNAL and the PAYLOAD travel through
// a SharedArrayBuffer:
//
//   SAB layout (little-endian):
//     [0]  Int32  flag      0 = busy/waiting, 1 = response ready
//     [1]  Int32  byteLen   response JSON byte length
//     [2…]  Uint8   payload  response JSON (UTF-8), fixed capacity
//
// The worker writes payload → byteLen → flag=1 + notify. The host only reads
// after flag=1; same-SAB stores from the worker are visible after the wake.

type WorkerRequest = { sql: string; values: unknown[] };
type WorkerResponse =
  | { ok: true; rows: unknown[]; rowCount: number }
  | { ok: false; error: string };

// 32 MB response capacity — well above any query here; larger results fail
// loudly instead of truncating.
const SAB_CAPACITY = 32 * 1024 * 1024;
const SAB_HEADER = 8; // flag + byteLen

const WORKER_SRC = /* js */ `
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const path = require('node:path');
const dns = require('node:dns');
// Many managed PG providers (Render, Supabase, …) expose IPv6 addresses, but
// common container hosts have no IPv6 route — connections fail with
// ENETUNREACH. Prefer IPv4 results when resolving the DB host.
dns.setDefaultResultOrder('ipv4first');
const sab = workerData.sab;
const flag = new Int32Array(sab, 0, 1);
const byteLen = new Int32Array(sab, 4, 1);
const payload = new Uint8Array(sab, 8);
const encoder = new TextEncoder();
const done = (obj) => {
  let bytes = encoder.encode(JSON.stringify(obj));
  if (bytes.length > payload.length) {
    bytes = encoder.encode(JSON.stringify({
      ok: false,
      error: 'pg_response_too_large: ' + bytes.length + ' bytes exceeds ' + payload.length + ' capacity',
    }));
  }
  payload.set(bytes);
  Atomics.store(byteLen, 0, bytes.length);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
};
let Pool;
try {
  // Resolve pg from the PROJECT root, not the eval'd worker's virtual path.
  const req = createRequire(path.join(workerData.projectRoot, 'package.json'));
  Pool = req('pg').Pool;
} catch (e) {
  done({ ok: false, error: 'pg_missing: ' + ((e && e.message) || String(e)) });
  parentPort.on('message', () => {}); // stay alive; host reports a clean error
}

if (Pool) {
  void (async () => {
    // Resolve the DB hostname to IPv4 ONCE and connect by address. Managed PG
    // hosts (Render, Supabase, …) advertise AAAA records, but common container
    // hosts have no IPv6 route — every connect then dies with ENETUNREACH.
    // Doing it here avoids relying on pg's lookup forwarding; TLS still verifies
    // against the original hostname via the servername option (SNI).
    const connString = workerData.url;
    let host = null;
    let sni = null;
    try {
      const u = new URL(workerData.url);
      const hostname = u.hostname;
      // Skip when the URL already names an IP literal (v4 or bracketed v6).
      if (hostname && !/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && !hostname.includes(':')) {
        try {
          const res = await dns.promises.lookup(hostname, { family: 4 });
          host = res.address;
          sni = hostname;
          console.log('[pg] resolved', hostname, '-> IPv4', host);
        } catch {
          console.log('[pg] hostname', hostname, 'has NO IPv4 (A) record; connecting as written');
        }
      } else {
        console.log('[pg] URL host is an IP literal; no DNS resolution needed');
      }
    } catch (e) {
      console.log('[pg] URL parse failed — letting pg surface its own error:', (e && e.message) || e);
    }
    const opts = {
      connectionString: connString,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'elyxion-arena',
    };
    if (host) {
      opts.host = host;
      opts.servername = sni;
    }
    let pool;
    try {
      pool = new Pool(opts);
    } catch (e) {
      done({ ok: false, error: 'pg_pool_init: ' + ((e && e.message) || String(e)) });
      return;
    }
    // Queue early requests until the pool exists; parentPort listeners below
    // only attach after the async setup, so nothing can be lost in between.
    pool.on('error', (err) => {
      // Rare idle-client failure; surface on the next query instead of crashing.
      console.error('[pg] pool error:', err && err.message);
    });
    parentPort.on('message', async (req) => {
      try {
        const res = await pool.query(req.sql, req.values);
        done({ ok: true, rows: res.rows, rowCount: res.rowCount ?? 0 });
      } catch (e) {
        done({ ok: false, error: (e && e.message) || String(e) });
      }
    });
    // Tell the host we are live — the host's very first exec waits for a
    // response, so the eager 'SELECT 1' probe guarantees the listener is up.
  })();
}
`;

class PgWorker {
  private readonly worker: Worker;
  private readonly sab = new SharedArrayBuffer(SAB_HEADER + SAB_CAPACITY);
  private readonly flag = new Int32Array(this.sab, 0, 1);
  private readonly byteLen = new Int32Array(this.sab, 4, 1);
  private readonly payload = new Uint8Array(this.sab, SAB_HEADER);
  private readonly decoder = new TextDecoder();

  constructor(cfg: PgConfig) {
    const projectRoot = path.resolve(process.cwd());
    this.worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { url: cfg.url, projectRoot, sab: this.sab },
      // Route worker stdout/stderr through this process so `[pg] pool error`
      // lines actually appear in the server log.
      stdout: true,
      stderr: true,
    });
    this.worker.on('error', (err) => {
      // The worker crashed before it could signal — synthesize an error
      // response in the shared buffer and wake the blocked host.
      const bytes = new TextEncoder().encode(
        JSON.stringify({ ok: false, error: `pg_worker_error: ${err.message}` }),
      );
      this.payload.set(bytes);
      Atomics.store(this.byteLen, 0, bytes.length);
      Atomics.store(this.flag, 0, 1);
      Atomics.notify(this.flag, 0);
    });
    // Eagerly probe so an unreachable DB fails at boot, not on first request.
    this.exec('SELECT 1', []);
  }

  exec(sql: string, values: unknown[]): { rows: unknown[]; rowCount: number } {
    Atomics.store(this.flag, 0, 0);
    Atomics.store(this.byteLen, 0, 0);
    const req: WorkerRequest = { sql, values };
    this.worker.postMessage(req);
    const waited = Atomics.wait(this.flag, 0, 0, 60_000);
    if (waited === 'timed-out') {
      throw new Error(`[db] PostgreSQL query timed out after 60s: ${sql.slice(0, 80)}…`);
    }
    const len = Atomics.load(this.byteLen, 0);
    let res: WorkerResponse;
    try {
      res = JSON.parse(this.decoder.decode(this.payload.subarray(0, len))) as WorkerResponse;
    } catch (e) {
      throw new Error(`[db] PostgreSQL worker response undecodable: ${(e as Error).message}`);
    }
    if (!res.ok) {
      if (res.error.startsWith('pg_missing')) {
        throw new Error('[db] PostgreSQL mode requires the "pg" package (npm install pg). ' + res.error);
      }
      throw new Error(`[db] PostgreSQL error: ${res.error} — while running: ${sql.slice(0, 1200)}`);
    }
    return { rows: res.rows, rowCount: res.rowCount };
  }

  /** Non-blocking connectivity probe for /api/live + the boot gate. */
  pingSync(): boolean {
    try {
      this.exec('SELECT 1', []);
      return true;
    } catch {
      return false;
    }
  }
}

// ── SQL translation ──────────────────────────────────────────────────────────

/**
 * Scalar max(a,b)/min(a,b) → GREATEST/LEAST.
 *
 * Better-sqlite3's `max(`/`min(` scalar forms only appear in this codebase as
 * 2-argument calls inside upsert SET clauses (e.g. `max(best_kill_streak,
 * excluded.best_kill_streak)` and `MIN(goal, MAX(progress, @value))`). PG has
 * no 2-arg min/max scalar, so they must become LEAST/GREATEST. Aggregate uses
 * are always written as COUNT/SUM/AVG here (or MAX(x) single-arg — untouched
 * by the 2-arg-aware regexes below), so aggregates never collide.
 */
function translateScalars(sql: string): string {
  // Only rewrite `max(`/`min(` when the call has exactly one top-level comma —
  // i.e. two arguments. Single-arg MAX(progress) stays an aggregate. Nested
  // calls (MIN(goal, MAX(progress, ?))) are handled by iterating: each pass
  // rewrites the innermost 2-arg calls, and the loop converges when no more
  // matches change the text.
  let out = sql;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(
      /\b(max|min)\(([^()]|\([^()]*\))*\)/gi,
      (whole: string, fn: string) => {
        // Extract the arg list (fn( … )) and strip nested parens to count
        // top-level commas: 2 args ⇒ scalar form → GREATEST/LEAST. Inner
        // nested calls were already rewritten by the previous pass.
        const args = whole.slice(fn.length + 1, -1);
        const flat = args.replace(/\([^()]*\)/g, '0');
        if (!flat.includes(',')) return whole;
        return `${fn.toLowerCase() === 'max' ? 'GREATEST' : 'LEAST'}${whole.slice(fn.length)}`;
      },
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Cast placeholders inside GREATEST/LEAST calls to bigint. node-postgres sends
 * parameters as untyped, and PG infers `text` for unknowns inside scalar
 * min/max — which then fails against bigint columns
 * ("column \"progress\" is of type bigint but expression is of type text").
 * All scalar-min/max uses in this schema are numeric.
 */
function castScalarPlaceholders(sql: string): string {
  return sql.replace(/\b(GREATEST|LEAST)\(\s*((?:[^()]|\([^()]*\))*?)\)/gi, (whole, fn: string, args: string) => {
    const cast = args.replace(/\$(\d+)(?!::)/g, '$$$1::bigint');
    return `${fn}(${cast})`;
  });
}

/** INSERT OR IGNORE → ON CONFLICT DO NOTHING (PG has no OR IGNORE). */
function translateInsertOrIgnore(sql: string): string {
  // Rewrites only the verb; the DO NOTHING clause is appended after the
  // statement's VALUES/SELECT tail. We do it textually: the codebase's
  // INSERT OR IGNORE statements all end with a closing `)` of the VALUES
  // list, so appending there is safe.
  return sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO');
}

/** Append `ON CONFLICT DO NOTHING` to an INSERT that came from OR IGNORE. */
function appendConflictDoNothing(sql: string): string {
  // Trim trailing whitespace/semicolon, then append the clause.
  const trimmed = sql.replace(/[\s;]+$/, '');
  return `${trimmed} ON CONFLICT DO NOTHING`;
}

function isInsertOrIgnore(sql: string): boolean {
  return /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
}

/**
 * Translate sqlite_master lookups to pg_catalog. db.ts uses exactly two
 * shapes (legacy-table rename migration):
 *   SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'instagib_%'
 *   SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%instagib%'
 * We map to pg_class with the same `name` column so the calling code is
 * untouched. LIKE with underscore wildcards behaves identically.
 */
function translateSqliteMaster(sql: string): string {
  if (!/sqlite_master/i.test(sql)) return sql;
  const isIndex = /type\s*=\s*'index'/i.test(sql);
  const relKind = isIndex ? "'i'" : "'r'";
  const likeMatch = /name\s+LIKE\s+'([^']*)'/i.exec(sql);
  const like = likeMatch ? ` AND c.relname LIKE '${likeMatch[1]}'` : '';
  return (
    `SELECT c.relname AS name FROM pg_class c ` +
    `JOIN pg_namespace n ON n.oid = c.relnamespace ` +
    `WHERE n.nspname = 'public' AND c.relkind = ${relKind}${like}`
  );
}

/**
 * PRAGMA table_info(t) → information_schema.columns, shaped as
 * { name } rows (that is all db.ts consumes: column-name sets for the
 * additive-column migration guard).
 */
function translatePragmaTableInfo(sql: string): string {
  const m = /^\s*PRAGMA\s+table_info\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;?\s*$/i.exec(sql);
  if (!m) return sql;
  return (
    `SELECT column_name AS name FROM information_schema.columns ` +
    `WHERE table_schema = 'public' AND table_name = '${m[1]}'`
  );
}

/**
 * In an ON CONFLICT … DO UPDATE SET, sqlite allows bare target-column
 * references on the right-hand side (they mean the existing row's values);
 * PG requires them to be table-qualified. Qualify every bare LHS-column
 * reference with the table name so `total_kills + excluded.total_kills`
 * becomes `elyxion_stats.total_kills + excluded.total_kills`.
 */
function qualifyConflictSetColumns(sql: string): string {
  const m = /INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)[\s\S]*?ON\s+CONFLICT/i.exec(sql);
  if (!m) return sql;
  const table = m[1];
  // Rewrite only inside the DO UPDATE SET clause: split at " DO UPDATE SET "
  // up to the clause end (RETURNING | ; | end).
  const setRe = /\bDO\s+UPDATE\s+SET\b/gi;
  const setMatch = setRe.exec(sql);
  if (!setMatch) return sql;
  const clauseStart = setMatch.index + setMatch[0].length;
  const endRe = /\bRETURNING\b|;|$/i;
  const endMatch = endRe.exec(sql.slice(clauseStart));
  const clauseEnd = clauseStart + (endMatch ? endMatch.index : sql.length - clauseStart);
  const clauseRaw = sql.slice(clauseStart, clauseEnd);
  // clauseEnd slicing starts right after "DO UPDATE SET" — but a leading SET
  // token can survive when the clause regex matched early; strip it and keep
  // it for reassembly.
  const clause = clauseRaw.replace(/^\s*SET\b/i, '');
  const setPrefix = clauseRaw.slice(0, clauseRaw.length - clause.length);
  // Qualify bare column refs on the RIGHT-hand side of each `col =` in the
  // DO UPDATE SET list. SET targets stay bare (PG rejects qualified targets).
  // Assignments are split on top-level commas (paren-balanced) so RHS calls
  // like GREATEST(a, b) survive as one unit.
  const assignments = splitAssignments(clause);
  // Preserve the clause's leading whitespace (between SET and the first
  // assignment) — splitAssignments keeps it in part[0].
  const lead = assignments.length > 0 ? (assignments[0].match(/^\s*/) ?? [''])[0] : '';
  const rewritten = (lead ? assignments.map((a, i) => (i === 0 ? a.slice(lead.length) : a)) : assignments)
    .map((a) => {
      const eq = a.indexOf('=');
      if (eq < 0) return a;
      const col = a.slice(0, eq).trim();
      const rhs = a.slice(eq + 1);
      // Keep the RHS's leading/trailing whitespace — trailing whitespace
      // separates the last assignment from a following RETURNING keyword.
      const leadWs = (rhs.match(/^\s*/) ?? [''])[0];
      const trailWs = (rhs.match(/\s*$/) ?? [''])[0];
      const qualified = rhs
        .trim()
        .replace(
          /(?<![\w."@])\b([A-Za-z_][A-Za-z0-9_]*)\b(?![\s.]*[A-Za-z_][A-Za-z0-9_]*\s*\.)(?!\s*\()/g,
          (word: string) =>
            /^(excluded|GREATEST|LEAST|TRUE|FALSE|NULL)$/i.test(word) || word === table || /^\d+$/.test(word)
              ? word
              : `${table}.${word}`,
        );
      return `${col} = ${leadWs}${qualified}${trailWs}`;
    })
    .join(',\n');
  return sql.slice(0, clauseStart) + setPrefix + lead + rewritten + sql.slice(clauseEnd);
}

/** Split a DO UPDATE SET body into `col = expr` assignments on top-level commas. */
function splitAssignments(clause: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of clause) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

export function translateSql(sql: string): string {
  let s = sql;
  s = translateSqliteMaster(s);
  s = translatePragmaTableInfo(s);
  s = translateDdl(s);
  s = translateInsertOrIgnore(s);
  s = translateScalars(s);
  s = qualifyConflictSetColumns(s);
  return s;
}

/**
 * DDL dialect fixes for the schema blocks db.ts runs through exec():
 *   INTEGER PRIMARY KEY AUTOINCREMENT → BIGINT GENERATED ALWAYS AS IDENTITY
 *   every remaining INTEGER column → BIGINT (epoch-ms timestamps overflow
 *     int4; PG bigint columns are returned as strings and coerced back by
 *     NUMERIC_COLS, so nothing else changes)
 *   BLOB → bytea
 * (CREATE TABLE/INDEX IF NOT EXISTS and UNIQUE constraints are already valid
 * PG. Note the ordering: the AUTOINCREMENT rewrite runs first so its
 * "INTEGER PRIMARY KEY" prefix is consumed before the generic widen.)
 */
export function translateDdl(sql: string): string {
  return sql
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGINT GENERATED ALWAYS AS IDENTITY')
    .replace(/\bINTEGER\b/gi, 'BIGINT')
    .replace(/\bBLOB\b/gi, 'bytea');
}

/** Number every `?` into $1..$n (positional style). */
function numberPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** Extract @named params in first-appearance order; null when none. */
function extractNamedParams(sql: string): string[] | null {
  const names: string[] = [];
  const seen = new Set<string>();
  const re = /@([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      names.push(m[1]);
    }
  }
  return names.length > 0 ? names : null;
}

/** Replace @named params with $n (reverse-length order so @ab is not hit by @a). */
function replaceNamedParams(sql: string, names: string[]): string {
  let out = sql;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`@${name}(?![A-Za-z0-9_])`, 'g'), `$${names.indexOf(name) + 1}`);
  }
  return out;
}

// ── Value conversion ─────────────────────────────────────────────────────────

/** sqlite-shaped JS values → PG-shaped bind values. */
function convertValue(v: unknown): unknown {
  if (v === undefined) return null; // better-sqlite3 binds undefined as NULL
  if (typeof v === 'boolean') return v ? 1 : 0; // schema uses INTEGER 0/1 flags
  return v;
}

// Column names that are guaranteed integers/floats in this schema (aggregates
// aliased as n/d/ms/xp/…, epoch-ms timestamps, stat counters). Only these are
// string→number coerced; everything else (usernames, hex ids, tokens — all
// TEXT in the schema) stays string so strict equality and `.trim()` calls keep
// working. node-postgres returns bigint/int8 columns as JS strings.
const NUMERIC_COLS = new Set([
  // aggregate aliases
  'n', 'd', 'ms', 'kills', 'deaths', 'fired', 'hit', 'xp',
  // epoch-ms timestamps
  'created_at', 'updated_at', 'used_at', 'expires_at', 'ts',
  // stat counters (elyxion_stats + period/mode variants)
  'total_kills', 'total_deaths', 'total_games', 'total_wins',
  'best_kill_streak', 'best_accuracy', 'headshots', 'shots_fired', 'shots_hit',
  'total_xp', 'best_kills', 'best_time_ms',
  // progression
  'level', 'credits', 'first_win_day', 'progress', 'goal',
  // ranked
  'rating', 'peak', 'season_id', 'week_key_int', 'rank',
  // misc counters / flags
  'id', 'is_admin', 'is_verified', 'used', 'claimed', 'wins', 'losses', 'games',
  'streak', 'raw_bytes', 'duration_ms', 'won', 'replays_stored', 'bytes', 'size',
]);

function coerceRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k in row) {
    const v = row[k];
    if (NUMERIC_COLS.has(k) && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Public facade: Database + Statement, better-sqlite3 shaped ───────────────

export type RunResult = { changes: number; lastInsertRowid: number | bigint };

export class PgStatement {
  constructor(
    private readonly client: PgWorker,
    private readonly sql: string,
    private readonly named: string[] | null,
    private readonly conflictNoop: boolean,
  ) {}

  private bind(args: unknown[]): { sql: string; values: unknown[] } {
    if (this.named) {
      const obj = (args[0] ?? {}) as Record<string, unknown>;
      return { sql: this.sql, values: this.named.map((name) => convertValue(obj[name])) };
    }
    return { sql: this.sql, values: args.map(convertValue) };
  }

  run(...args: unknown[]): RunResult {
    let { sql, values } = this.bind(args);
    if (this.conflictNoop) sql = appendConflictDoNothing(sql);
    // INSERTs without RETURNING that read lastInsertRowid: add RETURNING id.
    // Only valid for tables with an identity/PK id — harmless otherwise since
    // the only consumer (submitFeedback) targets elyxion_feedback.
    if (/^\s*INSERT\s+INTO/i.test(sql) && !/\bRETURNING\b/i.test(sql) && /elyxion_feedback/i.test(sql)) {
      sql = `${sql.replace(/[\s;]+$/, '')} RETURNING id`;
    }
    const { rowCount, rows } = this.client.exec(sql, values);
    // lastInsertRowid: the codebase's only consumer is submitFeedback, whose
    // INSERT ends with `RETURNING id` (PG honours it natively). Other inserts
    // simply never read lastInsertRowid.
    let lastInsertRowid = 0;
    if (rows.length > 0) {
      const first = rows[0] as Record<string, unknown>;
      const v = first['id'];
      if (typeof v === 'number') lastInsertRowid = v;
      else if (typeof v === 'string' && /^\d+$/.test(v)) lastInsertRowid = Number(v);
      else if (typeof v === 'bigint') lastInsertRowid = Number(v);
    }
    return { changes: rowCount, lastInsertRowid };
  }

  get(...args: unknown[]): unknown {
    const { sql, values } = this.bind(args);
    const { rows } = this.client.exec(sql, values);
    if (rows.length === 0) return undefined;
    return coerceRow(rows[0] as Record<string, unknown>);
  }

  all(...args: unknown[]): unknown[] {
    const { sql, values } = this.bind(args);
    const { rows } = this.client.exec(sql, values);
    return (rows as Record<string, unknown>[]).map(coerceRow);
  }
}

export class PgDatabase {
  private readonly worker: PgWorker;
  private readonly stmtCache = new Map<string, PgStatement>();

  constructor(cfg: PgConfig) {
    this.worker = new PgWorker(cfg);
  }

  prepare(sql: string): PgStatement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      const translated = translateSql(sql);
      const conflictNoop = isInsertOrIgnore(translated);
      const names = extractNamedParams(translated);
      const numbered = names
        ? replaceNamedParams(numberPlaceholdersSafe(translated), names)
        : numberPlaceholders(translated);
      // Cast AFTER numbering: the cast pass matches $n placeholders, which
      // only exist once ?/@name have been rewritten.
      const finalSql = castScalarPlaceholders(numbered);
      stmt = new PgStatement(this.worker, finalSql, names, conflictNoop);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  exec(sql: string): unknown {
    // DDL / multi-statement path (schema bootstrap + migrations). PG's simple
    // query protocol accepts multi-statement strings with no binds.
    const translated = translateSql(sql);
    const statements = splitStatements(translated);
    for (const s of statements) {
      if (s.trim().length === 0) continue;
      const conflictNoop = isInsertOrIgnore(s);
      this.worker.exec(conflictNoop ? appendConflictDoNothing(s) : s, []);
    }
    return undefined;
  }

  pragma(_statement: string): unknown {
    // WAL / busy_timeout / synchronous have no PG analogue; connection pooling
    // covers the durability/latency tradeoffs they manage on sqlite.
    return undefined;
  }

  /** True when the backend answers (used for /api/live + boot gate). */
  pingSync(): boolean {
    return this.worker.pingSync();
  }

  /** Live backend tag for logs/health. */
  get backend(): string {
    return 'postgres';
  }
}

/**
 * Number ? placeholders but leave @named ones for replaceNamedParams.
 * (sqlite SQL never mixes both styles in one statement in this codebase, but
 * this keeps the ordering deterministic regardless.)
 */
function numberPlaceholdersSafe(sql: string): string {
  // Temporarily mask @name tokens, number ?, then restore.
  const MASK = '\u0000NAMED\u0000';
  const named: string[] = [];
  const masked = sql.replace(/@[A-Za-z_][A-Za-z0-9_]*/g, (m) => {
    named.push(m);
    return MASK + (named.length - 1) + MASK;
  });
  const numbered = numberPlaceholders(masked);
  return numbered.replace(new RegExp(`${MASK}(\\d+)${MASK}`, 'g'), (_, i) => named[Number(i)]);
}

/**
 * Split a multi-statement SQL string on top-level semicolons (respecting
 * single quotes, double quotes, dollar-quoted strings, and -- / /* comments).
 * The DDL blocks in db.ts contain only straight CREATE TABLE/INDEX/ALTER with
 * quoted identifiers and '--' comments, but the splitter is defensive anyway.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  let inS: false | "'" | '"' | '$' = false;
  let dollarTag = '';
  let inLineComment = false;
  let inBlockComment = false;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      cur += c;
      if (c === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      cur += c;
      if (c === '*' && next === '/') {
        cur += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i++;
      continue;
    }
    if (inS === "'" || inS === '"') {
      cur += c;
      if (c === inS) {
        if (next === inS) {
          cur += next; // escaped quote
          i += 2;
          continue;
        }
        inS = false;
      }
      i++;
      continue;
    }
    if (inS === '$') {
      cur += c;
      if (sql.startsWith(dollarTag, i)) {
        cur += dollarTag.length - 1 > 0 ? dollarTag : '';
        i += dollarTag.length;
        inS = false;
      } else i++;
      continue;
    }
    if (c === '-' && next === '-') {
      inLineComment = true;
      cur += c;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      cur += c + next;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      inS = c;
      cur += c;
      i++;
      continue;
    }
    if (c === '$') {
      // Possible dollar-quote open ($tag$). Scan for the closing $.
      const close = sql.indexOf('$', i + 1);
      if (close > i) {
        dollarTag = sql.slice(i, close + 1);
        inS = '$';
        cur += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (c === ';') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  out.push(cur);
  return out;
}
