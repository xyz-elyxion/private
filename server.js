// Elyxion Registry & Site Server
// -----------------------------------------------
// One server that does two jobs:
//   1. Serves the static marketing site from dist/ (built by build.js)
//   2. Hosts the package registry API used by `elyx login / publish /
//      install / search` — users, tokens, and packages live in data/.
//
// Runs entirely on the Elyxion runtime: native TCP + fs + crypto.
// No Node.js, no Python, no dependencies.
//
//   elyxion site/server.js
//
// Env vars:
//   PORT         Port to listen on (default: 3000)
//   DATA_DIR     Where users/tokens/packages are stored (default: site/data)
//   PUBLIC_URL   Public base URL used in package metadata (default: https://xyz-elyxion.onrender.com)
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DIST = path.join(__dirname, 'dist');
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://xyz-elyxion.onrender.com';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const START_TIME = Date.now(); // runtime has no process.uptime()

// Build the static site on first run if dist/ is missing
// (e.g. fresh clone — keeps the deployment self-sufficient)
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('Site not built — running build.js...');
  try {
    const { execSync } = require('child_process');
    execSync(process.argv[0] + ' ' + path.join(__dirname, 'build.js'));
  } catch (e) {
    console.log('Build failed — writing fallback page...');
    try {
      fs.mkdirSync(DIST, { recursive: true });
      fs.writeFileSync(path.join(DIST, 'index.html'),
        '<!DOCTYPE html><html><head><title>Elyxion</title></head>' +
        '<body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;text-align:center;padding-top:4rem;">' +
        '<h1>Elyxion Registry</h1><p>Server is running.</p></body></html>');
    } catch (_) {}
  }
}

// ---- Byte-length helper (UTF-8 aware) -------------------------
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

// ---- Storage (file-based JSON, one file per collection) -------
function storeFile(name) {
  return path.join(DATA_DIR, name + '.json');
}

function load(name, fallback) {
  try {
    const raw = fs.readFileSync(storeFile(name));
    if (raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function save(name, data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
  fs.writeFileSync(storeFile(name), JSON.stringify(data, null, 2), 'utf-8');
}

// ---- Auth primitives ------------------------------------------
// Note: the runtime's crypto.createHash is a lightweight hash (not
// cryptographically secure). Salting + hashing keeps passwords out of
// plain text; swap for a real KDF (bcrypt/scrypt) when the runtime
// grows native crypto.
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

function makeSalt() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function makeToken() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2) +
         Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function bearerToken(headers) {
  const auth = headers['authorization'] || headers['Authorization'] || '';
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function authenticate(headers) {
  const token = bearerToken(headers);
  if (!token) return null;
  const tokens = load('tokens', {});
  const entry = tokens[token];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    delete tokens[token];
    save('tokens', tokens);
    return null;
  }
  const users = load('users', {});
  const user = users[entry.username];
  if (!user) return null;
  return { username: entry.username, user, token };
}

function issueToken(username) {
  const tokens = load('tokens', {});
  const token = makeToken();
  tokens[token] = { username, createdAt: Date.now(), expiresAt: Date.now() + TOKEN_TTL_MS };
  save('tokens', tokens);
  return token;
}

// ---- Package validation ---------------------------------------
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// ---- HTTP helpers ---------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function getMime(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function buildResponse(status, contentType, body, contentLength, extraHeaders) {
  const headers = [
    'HTTP/1.1 ' + status,
    'Content-Type: ' + contentType,
    'Content-Length: ' + contentLength,
    'Connection: close',
    'Server: Elyxion',
    'Access-Control-Allow-Origin: *',
    'Access-Control-Allow-Headers: Authorization, Content-Type',
    'Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS',
  ];
  if (extraHeaders) {
    for (const h of extraHeaders) headers.push(h);
  }
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

function sendText(socket, status, body, contentType) {
  const ct = contentType || 'text/plain; charset=utf-8';
  socket.write(buildResponse(status, ct, body, byteLen(body)));
  socket.end();
}

function sendJSON(socket, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  socket.write(buildResponse(status, 'application/json; charset=utf-8', body, byteLen(body)));
  socket.end();
}

function sendFile(socket, filePath, status) {
  try {
    const content = fs.readFileSync(filePath);
    const st = fs.statSync(filePath);
    if (content === undefined) throw new Error('empty');
    const size = (st && st.size) ? st.size : byteLen(content);
    socket.write(buildResponse(status || '200 OK', getMime(filePath), content, size));
    socket.end();
    return true;
  } catch (_) {
    return false;
  }
}

// ---- Registry logic -------------------------------------------
function packageSummary(name, pkg) {
  const latest = (pkg['dist-tags'] && pkg['dist-tags'].latest) || '1.0.0';
  const latestVer = (pkg.versions && pkg.versions[latest]) || {};
  return {
    name,
    description: pkg.description || '',
    latest,
    owner: pkg.owner,
    keywords: latestVer.keywords || [],
    updated: (pkg.versions && pkg.versions[latest] && pkg.versions[latest].publishedAt) || pkg.createdAt,
  };
}

function publicPackage(name, pkg) {
  const versions = {};
  const time = { created: pkg.createdAt };
  for (const [v, meta] of Object.entries(pkg.versions || {})) {
    versions[v] = {
      name,
      version: v,
      description: meta.description || pkg.description || '',
      main: meta.main || 'index.js',
      dependencies: meta.dependencies || {},
      keywords: meta.keywords || [],
      license: meta.license || null,
      author: meta.author || null,
      owner: meta.publishedBy || pkg.owner,
      dist: {
        shasum: meta.shasum || null,
      },
    };
    time[v] = meta.publishedAt;
  }
  return {
    name,
    description: pkg.description || '',
    owner: pkg.owner,
    'dist-tags': pkg['dist-tags'] || { latest: '1.0.0' },
    versions,
    time,
  };
}

function handlePublish(auth, body) {
  if (!auth) return sendJSON(this, 401, { error: 'Not authenticated. Run: elyx login' });

  const manifest = body && body.package;
  if (!manifest || typeof manifest !== 'object') {
    return sendJSON(this, 400, { error: 'Body must include a "package" object (your package.json)' });
  }

  const name = manifest.name;
  const version = manifest.version;
  if (!name || !NAME_RE.test(name)) {
    return sendJSON(this, 400, { error: 'Invalid package name (use lowercase letters, numbers, . _ -)' });
  }
  if (!version || !VERSION_RE.test(version)) {
    return sendJSON(this, 400, { error: 'Invalid version (expected semver like 1.0.0)' });
  }

  const packages = load('packages', {});
  const existing = packages[name];
  if (existing && existing.owner !== auth.username) {
    return sendJSON(this, 403, { error: `Package "${name}" is owned by ${existing.owner}` });
  }

  const now = new Date().toISOString();
  const pkg = existing || {
    name,
    owner: auth.username,
    description: manifest.description || '',
    createdAt: now,
    'dist-tags': {},
    versions: {},
  };

  const shasum = crypto.createHash('sha256')
    .update(JSON.stringify(manifest))
    .digest('hex');

  pkg.versions[version] = {
    version,
    publishedBy: auth.username,
    publishedAt: now,
    main: manifest.main || 'index.js',
    description: manifest.description || '',
    dependencies: manifest.dependencies || {},
    keywords: manifest.keywords || [],
    license: manifest.license || null,
    author: manifest.author || null,
    readme: body.readme || null,
    shasum,
  };
  if (manifest.description) pkg.description = manifest.description;
  pkg['dist-tags'].latest = version;

  packages[name] = pkg;
  save('packages', packages);

  // Track ownership on the user record
  const users = load('users', {});
  if (users[auth.username]) {
    if (!users[auth.username].packages.includes(name)) {
      users[auth.username].packages.push(name);
    }
    save('users', users);
  }

  return sendJSON(this, 201, { ok: true, name, version, publishedBy: auth.username });
}

// ---- Route handler --------------------------------------------
function handleRequest(method, url, headers, body, socket) {
  const pathname = url.split('?')[0];
  const query = url.split('?')[1] || '';
  const qs = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [k, v] = pair.split('=');
    qs[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }

  // CORS preflight
  if (method === 'OPTIONS') {
    return sendText(socket, '204 No Content', '');
  }

  // ---- API routes ---------------------------------------------
  if (pathname.startsWith('/api/')) {
    return handleApi(method, pathname, qs, headers, body, socket);
  }

  // GET /health — check the service is up
  if (method === 'GET' && pathname === '/health') {
    return sendJSON(socket, 200, { ok: true, service: 'elyxion-registry', uptime: Math.floor((Date.now() - START_TIME) / 1000) });
  }

  // ---- Static site --------------------------------------------
  let filePath;
  if (pathname === '/' || pathname === '') {
    filePath = path.join(DIST, 'index.html');
  } else {
    const safe = pathname.replace(/\.\./g, '').replace(/\/\//g, '/');
    filePath = path.join(DIST, safe);
  }

  try {
    const st = fs.statSync(filePath);
    if (st && st.isDirectory && st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch (_) {}

  if (sendFile(socket, filePath)) return;

  // Extensionless paths fall back to .html (e.g. /about -> about.html)
  if (!path.extname(pathname) && sendFile(socket, filePath + '.html')) return;

  const notFound =
    '<!DOCTYPE html><html><head><title>404</title></head>' +
    '<body style="font-family:sans-serif;text-align:center;padding-top:4rem;background:#0d1117;color:#c9d1d9;">' +
    '<h1 style="font-size:5rem;color:#8b5cf6;">404</h1>' +
    '<p>Not Found</p><p><a href="/" style="color:#a78bfa;">Back home</a></p></body></html>';
  sendText(socket, '404 Not Found', notFound, 'text/html; charset=utf-8');
}

function handleApi(method, pathname, qs, headers, body, socket) {
  const auth = authenticate(headers);
  const parts = pathname.split('/').filter(Boolean); // e.g. ['api','packages','foo']

  // GET /api/packages
  if (method === 'GET' && parts.length === 2 && parts[1] === 'packages') {
    const packages = load('packages', {});
    const list = Object.keys(packages).sort().map((n) => packageSummary(n, packages[n]));
    return sendJSON(socket, 200, { packages: list, count: list.length });
  }

  // GET /api/search?q=
  if (method === 'GET' && parts.length === 2 && parts[1] === 'search') {
    const q = (qs.q || '').toLowerCase();
    if (!q) return sendJSON(socket, 400, { error: 'Missing ?q= query param' });
    const packages = load('packages', {});
    const results = [];
    for (const [name, pkg] of Object.entries(packages)) {
      const latest = (pkg['dist-tags'] && pkg['dist-tags'].latest) || '1.0.0';
      const latestVer = (pkg.versions && pkg.versions[latest]) || {};
      const haystack = [name, pkg.description || '', (latestVer.keywords || []).join(' '), pkg.owner].join(' ').toLowerCase();
      if (haystack.includes(q)) results.push(packageSummary(name, pkg));
    }
    return sendJSON(socket, 200, { packages: results, count: results.length });
  }

  // GET /api/stats
  if (method === 'GET' && parts.length === 2 && parts[1] === 'stats') {
    const packages = load('packages', {});
    const users = load('users', {});
    let versions = 0;
    for (const pkg of Object.values(packages)) versions += Object.keys(pkg.versions || {}).length;
    return sendJSON(socket, 200, { packages: Object.keys(packages).length, users: Object.keys(users).length, versions });
  }

  // ---- Auth routes --------------------------------------------
  // POST /api/auth/register
  if (method === 'POST' && parts.length === 3 && parts[1] === 'auth' && parts[2] === 'register') {
    const username = String((body && body.username) || '').trim().toLowerCase();
    const password = String((body && body.password) || '');
    if (!username || !/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username)) {
      return sendJSON(socket, 400, { error: 'Username must be 3-32 chars (letters, numbers, _ -)' });
    }
    if (password.length < 4) {
      return sendJSON(socket, 400, { error: 'Password must be at least 4 characters' });
    }
    const users = load('users', {});
    if (users[username]) {
      return sendJSON(socket, 409, { error: 'Username already taken' });
    }
    const salt = makeSalt();
    users[username] = {
      username,
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: new Date().toISOString(),
      packages: [],
    };
    save('users', users);
    const token = issueToken(username);
    return sendJSON(socket, 201, { ok: true, token, username });
  }

  // POST /api/auth/login
  if (method === 'POST' && parts.length === 3 && parts[1] === 'auth' && parts[2] === 'login') {
    const username = String((body && body.username) || '').trim().toLowerCase();
    const password = String((body && body.password) || '');
    const users = load('users', {});
    const user = users[username];
    if (!user || user.passwordHash !== hashPassword(password, user.salt)) {
      return sendJSON(socket, 401, { error: 'Invalid username or password' });
    }
    const token = issueToken(username);
    return sendJSON(socket, 200, { ok: true, token, username });
  }

  // POST /api/auth/logout
  if (method === 'POST' && parts.length === 3 && parts[1] === 'auth' && parts[2] === 'logout') {
    const token = bearerToken(headers);
    const tokens = load('tokens', {});
    if (token && tokens[token]) {
      delete tokens[token];
      save('tokens', tokens);
    }
    return sendJSON(socket, 200, { ok: true });
  }

  // GET /api/auth/me
  if (method === 'GET' && parts.length === 3 && parts[1] === 'auth' && parts[2] === 'me') {
    if (!auth) return sendJSON(socket, 401, { error: 'Not authenticated' });
    return sendJSON(socket, 200, {
      username: auth.username,
      packages: auth.user.packages || [],
      createdAt: auth.user.createdAt,
    });
  }

  // ---- Package routes -----------------------------------------
  // POST /api/packages  (publish)
  if (method === 'POST' && parts.length === 2 && parts[1] === 'packages') {
    return handlePublish.call(socket, auth, body);
  }

  // GET /api/packages/:name
  if (method === 'GET' && parts.length === 3 && parts[1] === 'packages') {
    const name = decodeURIComponent(parts[2]);
    const packages = load('packages', {});
    if (!packages[name]) return sendJSON(socket, 404, { error: `Package "${name}" not found` });
    return sendJSON(socket, 200, publicPackage(name, packages[name]));
  }

  // GET /api/packages/:name/:version  +  .../metadata
  if (method === 'GET' && parts.length >= 4 && parts[1] === 'packages') {
    const name = decodeURIComponent(parts[2]);
    let version = decodeURIComponent(parts[3]);
    const packages = load('packages', {});
    const pkg = packages[name];
    if (!pkg) return sendJSON(socket, 404, { error: `Package "${name}" not found` });
    if (version === 'latest') version = (pkg['dist-tags'] && pkg['dist-tags'].latest) || '1.0.0';
    if (!pkg.versions[version]) return sendJSON(socket, 404, { error: `Version ${version} not found` });
    const meta = publicPackage(name, pkg).versions[version];
    return sendJSON(socket, 200, meta);
  }

  // DELETE /api/packages/:name/:version  (owner only)
  if (method === 'DELETE' && parts.length >= 4 && parts[1] === 'packages') {
    if (!auth) return sendJSON(socket, 401, { error: 'Not authenticated' });
    const name = decodeURIComponent(parts[2]);
    let version = decodeURIComponent(parts[3]);
    const packages = load('packages', {});
    const pkg = packages[name];
    if (!pkg) return sendJSON(socket, 404, { error: `Package "${name}" not found` });
    if (pkg.owner !== auth.username) {
      return sendJSON(socket, 403, { error: `Only ${pkg.owner} can unpublish this package` });
    }
    if (version === 'latest') version = (pkg['dist-tags'] && pkg['dist-tags'].latest) || '1.0.0';
    if (!pkg.versions[version]) return sendJSON(socket, 404, { error: `Version ${version} not found` });
    delete pkg.versions[version];
    if (Object.keys(pkg.versions).length === 0) {
      delete packages[name];
    } else {
      const remaining = Object.keys(pkg.versions).sort();
      pkg['dist-tags'].latest = remaining[remaining.length - 1];
      packages[name] = pkg;
    }
    save('packages', packages);
    return sendJSON(socket, 200, { ok: true, name, version: 'unpublished' });
  }

  return sendJSON(socket, 404, { error: 'Not found', path: pathname });
}

// ---- Connection handling --------------------------------------
const server = net.createServer((socket) => {
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk;

    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      if (buffer.length > 65536) {
        sendText(socket, '413 Payload Too Large', 'Request too large');
      }
      return;
    }

    const headerSection = buffer.substring(0, headerEnd);
    const lines = headerSection.split('\r\n');
    const requestLine = lines[0] || '';
    const parts = requestLine.split(' ');
    const method = parts[0] || 'GET';
    const url = parts[1] || '/';

    // Parse headers into an object (lowercased keys)
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(':');
      if (idx === -1) continue;
      headers[lines[i].substring(0, idx).trim().toLowerCase()] = lines[i].substring(idx + 1).trim();
    }

    // Read the request body per Content-Length
    const contentLength = parseInt(headers['content-length'] || '0', 10);
    const bodyStart = headerEnd + 4;
    const available = buffer.length - bodyStart;

    if (available < contentLength) {
      if (buffer.length > 2 * 1024 * 1024) {
        sendText(socket, '413 Payload Too Large', 'Request too large');
      }
      return; // wait for more data
    }

    const rawBody = buffer.substring(bodyStart, bodyStart + contentLength);

    let body = null;
    const contentType = (headers['content-type'] || '').toLowerCase();
    if (rawBody && contentType.includes('application/json')) {
      try {
        body = JSON.parse(rawBody);
      } catch (_) {
        sendJSON(socket, 400, { error: 'Invalid JSON body' });
        return;
      }
    } else if (rawBody) {
      body = rawBody;
    }

    handleRequest(method, url, headers, body, socket);
  });

  socket.on('error', () => {
    // Ignore socket errors (client aborts, etc.)
  });
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
  process.exit(1);
});

// ---- Start ----------------------------------------------------
console.log('');
console.log('  ⚡ Elyxion Registry Server');
console.log('     ' + PUBLIC_URL);
console.log('     Data: ' + DATA_DIR);
console.log('');

server.listen(PORT, () => {
  console.log('  Listening on port ' + PORT + '. Press Ctrl+C to stop.');
  console.log('');
});

process.nextTick(function loop() {
  setTimeout(loop, 60000);
});
