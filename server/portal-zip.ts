// Streams the production static build (dist/) as a ZIP archive, for uploading
// the game bundle to gaming portals (CrazyGames, Poki, itch, Kongregate…).
// Zero dependencies: hand-rolled ZIP writer using the STORE method (no
// compression — Vite emits pre-compressed/hashed assets where DEFLATE saves
// little and costs CPU; portals re-compress at their CDN anyway). Files larger
// than BUFFER_LIMIT are refused so the in-memory buffering below can never
// balloon silently; if a future asset exceeds it, fail loudly instead of OOM.
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';

const BUFFER_LIMIT = 256 * 1024 * 1024; // refuse single files beyond 256 MB

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const DOS_TIME = (d: Date) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const DOS_DATE = (d: Date) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

// Walk dist/, collecting every regular file with forward-slash ZIP paths.
function walk(dir: string, root: string, out: { full: string; rel: string }[] = []): { full: string; rel: string }[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, out);
    else if (entry.isFile()) out.push({ full, rel: path.relative(root, full).split(path.sep).join('/') });
  }
  return out;
}

/** Write a 16/32-bit little-endian chunk. */
function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff, 0);
  return b;
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

/** Header for a local file entry (STORE method, sizes known up front). */
function localHeader(name: string, crc: number, size: number, dtime: number, ddate: number): Buffer {
  return Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(0), u16(dtime), u16(ddate),
    u32(crc), u32(size), u32(size), u16(Buffer.byteLength(name, 'utf8')), u16(0),
  ]);
}

/** Header for a central-directory file entry. */
function centralHeader(name: string, crc: number, size: number, offset: number, dtime: number, ddate: number): Buffer {
  return Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(dtime), u16(ddate),
    u32(crc), u32(size), u32(size), u16(Buffer.byteLength(name, 'utf8')), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(offset),
  ]);
}

export type PortalZipResult =
  | { ok: true; done: Promise<void> }
  | { ok: false; error: 'build_missing' | 'file_too_large' | 'too_many_files' };

/**
 * Stream a ZIP of `distDir` (+ optional PORTAL-README.txt) to an Express
 * response. Files are read fully into memory (bounded per-file by
 * BUFFER_LIMIT) so the archive can be written sequentially with correct
 * headers and a valid central directory. Never throws — failures after the
 * response headers are sent abort the connection instead.
 */
export function sendPortalZip(
  res: Response,
  opts: {
    distDir: string;
    name: string;
    ver: string;
    readme?: string;
    /** Transform for the shell index.html as it enters the archive (never on disk). */
    indexHtmlTransform?: (html: string) => string;
  },
): PortalZipResult {
  void opts.ver; // reserved: per-entry comment/metadata once portals want it
  let files: { full: string; rel: string }[];
  try {
    files = walk(opts.distDir, opts.distDir);
  } catch {
    return { ok: false, error: 'build_missing' };
  }
  for (const f of files) {
    if (statSync(f.full).size > BUFFER_LIMIT) return { ok: false, error: 'file_too_large' };
  }
  if (files.length > 20000) return { ok: false, error: 'too_many_files' };

  const mtime = new Date();
  const dtime = DOS_TIME(mtime);
  const ddate = DOS_DATE(mtime);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${opts.name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders?.();

  const central: { name: string; crc: number; size: number; offset: number }[] = [];
  const out: Buffer[] = [];
  let offset = 0;

  const addEntry = (name: string, data: Buffer) => {
    const crc = crc32(data);
    const header = localHeader(name, crc, data.length, dtime, ddate);
    const nameBytes = Buffer.from(name, 'utf8');
    // Local entry = 30-byte header + filename bytes + file data.
    out.push(header, nameBytes, data);
    central.push({ name, crc, size: data.length, offset });
    offset += header.length + nameBytes.length + data.length;
  };

  // README first so a portal reviewer opening the archive sees it immediately.
  if (opts.readme) addEntry('PORTAL-README.txt', Buffer.from(opts.readme, 'utf8'));

  // Read every dist file (per-file bounded), then write the whole archive.
  const reads = files.map(
    (f) =>
      new Promise<Buffer>((resolve, reject) => {
        // The shell gets the backend-origin stamp applied in-memory only.
        if (opts.indexHtmlTransform && f.rel === 'index.html') {
          fsReadFile(f.full, 'utf8')
            .then((html) => resolve(Buffer.from(opts.indexHtmlTransform!(html), 'utf8')))
            .catch(reject);
          return;
        }
        const rs = createReadStream(f.full);
        const parts: Buffer[] = [];
        rs.on('data', (c) => parts.push(c as Buffer));
        rs.on('end', () => resolve(Buffer.concat(parts)));
        rs.on('error', reject);
      }),
  );

  const done = Promise.all(reads)
    .then(async (buffers) => {
      buffers.forEach((data, i) => addEntry(files[i].rel, data));
      const centralStart = offset;
      for (const e of central) {
        const h = centralHeader(e.name, e.crc, e.size, e.offset, dtime, ddate);
        out.push(h, Buffer.from(e.name, 'utf8'));
        offset += h.length + Buffer.byteLength(e.name, 'utf8');
      }
      const centralSize = offset - centralStart;
      out.push(
        Buffer.concat([
          u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
          u32(centralSize), u32(centralStart), u16(0),
        ]),
      );
      for (const c of out) res.write(c);
      res.end();
    })
    .catch((err: unknown) => {
      // Headers are already sent — abort the connection rather than 500.
      res.destroy(err instanceof Error ? err : undefined);
    });
  return { ok: true, done };
}
