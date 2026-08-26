// Elyxion Inline HTTP Server — no dependencies, no python
// Uses native TCP module + fs module directly.
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DIST = path.join(__dirname, 'dist');

// Ensure the site is built
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('Site not built. Running build...');
  try {
    // The build script is in the repo source tree, not dist
    const build = require('child_process');
    build.execSync(process.argv[0] + ' ' + path.join(__dirname, 'build.js'), { stdio: 'inherit' });
  } catch (e) {
    console.log('Build failed, trying fallback...');
    // Create a minimal index.html inline
    fs.mkdirSync(DIST, { recursive: true });
    fs.writeFileSync(path.join(DIST, 'index.html'),
      '<!DOCTYPE html><html><head><title>Elyxion</title></head>' +
      '<body><h1>Elyxion is running!</h1></body></html>');
  }
}

// ---- MIME types -------------------------------------------------
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

// ---- HTTP helpers -----------------------------------------------
function buildResponse(status, contentType, body, contentLength) {
  var headers = [
    'HTTP/1.1 ' + status,
    'Content-Type: ' + contentType,
    'Content-Length: ' + contentLength,
    'Connection: close',
    'Server: Elyxion',
  ];
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

// ---- Route handler ----------------------------------------------
function handleRequest(method, url, socket) {
  // Strip query string
  const pathname = url.split('?')[0];

  // Determine file path
  var filePath;
  if (pathname === '/') {
    filePath = path.join(DIST, 'index.html');
  } else {
    // Security: prevent directory traversal
    var safe = pathname.replace(/\.\./g, '').replace(/\/\//g, '/');
    filePath = path.join(DIST, safe);
  }

  // Check if it's a directory (serve index.html)
  try {
    var st = fs.statSync(filePath);
    if (st && st.isDirectory && st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch (_) {}

  // Extensionless paths fall back to .html (e.g. /about -> about.html)
  var candidate = filePath;
  if (!path.extname(pathname)) candidate = filePath + '.html';
  filePath = candidate;

  // Try to serve the file — use stat size for accurate Content-Length
  try {
    var content = fs.readFileSync(filePath);
    var fileStat = fs.statSync(filePath);
    if (content !== undefined) {
      var mime = getMime(filePath);
      var size = (fileStat && fileStat.size) ? fileStat.size : 0;
      socket.write(buildResponse('200 OK', mime, content, size));
      return;
    }
  } catch (_) {}

  // 404 — use actual byte length for the inline string
  var notFound = '<!DOCTYPE html><html><head><title>404</title></head>' +
    '<body style="font-family:sans-serif;text-align:center;padding-top:4rem;background:#0d1117;color:#c9d1d9;">' +
    '<h1 style="font-size:5rem;color:#8b5cf6;">404</h1>' +
    '<p>Not Found</p><p><a href="/" style="color:#a78bfa;">Back home</a></p></body></html>';
  var nfEncoded = encodeURIComponent(notFound);
  // count UTF-8 bytes from percent-encoded form
  var nfBytes = 0;
  for (var i = 0; i < nfEncoded.length; i++) {
    if (nfEncoded.charAt(i) === '%') { nfBytes += parseInt(nfEncoded.substr(i + 1, 2), 16); i += 2; }
    else { nfBytes += 1; }
  }
  socket.write(buildResponse('404 Not Found', 'text/html; charset=utf-8', notFound, nfBytes));
}

// ---- Start server -----------------------------------------------
console.log('');
console.log('  ⚡ Elyxion HTTP Server');
console.log('     http://localhost:' + PORT);
console.log('');

const server = net.createServer((socket) => {
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk;

    // HTTP headers end with \r\n\r\n
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      // Headers not complete yet — wait for more data
      // (keep-alive: we could get multiple requests, but for now
      //  we close after each one, so headers + partial body is fine)
      if (buffer.length > 8192) {
        // Too large, close
        var errBody = 'Request too large';
        socket.write(buildResponse('413 Payload Too Large', 'text/plain', errBody, errBody.length));
        socket.end();
      }
      return;
    }

    const headerSection = buffer.substring(0, headerEnd);
    const lines = headerSection.split('\r\n');
    const requestLine = lines[0] || '';
    const parts = requestLine.split(' ');
    const method = parts[0] || 'GET';
    const url = parts[1] || '/';

    handleRequest(method, url, socket);

    // Close after first request (simplifies the server)
    socket.end();
  });

  socket.on('end', () => {
    // Client disconnected
  });

  socket.on('error', (err) => {
    // Ignore common socket errors
  });
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('  Listening on port ' + PORT + '. Press Ctrl+C to stop.');
  console.log('');
});

// Keep alive
process.nextTick(function loop() {
  // The event loop handles keepalive via uv_run
  setTimeout(loop, 60000);
});