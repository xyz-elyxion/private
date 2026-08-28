// Elyxion Discord Framework — REST client
// ---------------------------------------------------------------
// Talks to the Discord REST API. The Elyxion runtime has no
// outbound TLS client yet, so requests go through `curl` (present
// on macOS, Linux, and Windows 10+) — the same approach the
// Elyxion package manager uses for registry traffic.
//
// Advanced behavior: rate-limit buckets are tracked from the
// X-RateLimit-* headers, 429 and 5xx responses are retried with
// exponential backoff, and multipart file uploads are supported.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const DEFAULT_BASE_URL = 'https://discord.com/api/v10';

// Quote an argument for use with execSync. Windows shells out to
// cmd.exe, which does NOT honor single quotes — everything must be
// double-quoted (cmd strips " inside via doubling). POSIX bash accepts
// double quotes identically, so this form works on every platform.
function shellQuote(arg) {
  return '"' + String(arg).replace(/"/g, '""') + '"';
}

// Synchronous sleep without dependencies. Uses Atomics.wait where
// available (Node/V8), falling back to a busy loop.
function sleepSync(ms) {
  ms = Math.max(0, Math.ceil(ms || 0));
  if (typeof SharedArrayBuffer === 'function' && typeof Atomics !== 'undefined' && Atomics.wait) {
    try {
      const sab = new SharedArrayBuffer(4);
      const arr = new Int32Array(sab);
      Atomics.wait(arr, 0, 0, ms);
      return;
    } catch (_) { /* fall through to busy loop */ }
  }
  const start = Date.now();
  while (Date.now() - start < ms) { /* busy wait */ }
}

// Normalize a route so requests that share a rate-limit bucket map
// to the same key: snowflake ids become {id}.
function routeKey(method, pathName) {
  return String(method).toUpperCase() + ' ' + String(pathName).replace(/\d{17,20}/g, '{id}');
}

// Parse a raw HTTP header block (e.g. curl -D output) into a
// lowercase-keyed map.
function parseHeaders(block) {
  const headers = {};
  for (const line of String(block || '').split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m && m[1]) headers[m[1].toLowerCase().trim()] = m[2].trim();
  }
  return headers;
}

class RestClient {
  constructor(options = {}) {
    this.token = options.token || null;
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = options.timeout || 15000;
    this.maxRetries = options.maxRetries === undefined ? 3 : options.maxRetries;
    this.retryBackoff = options.retryBackoff || 500;
    this._buckets = {}; // bucket id or route key -> { remaining, resetAt }
  }

  _headers() {
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'ElyxionDiscord/0.2.0'
    };
    if (this.token) headers['Authorization'] = 'Bot ' + this.token;
    return headers;
  }

  // request(method, path, body) -> { statusCode, data, body, headers }
  // Never throws on HTTP error codes — callers inspect statusCode.
  // 429 and 5xx responses are retried with exponential backoff, and
  // rate-limit buckets are honored before each request.
  request(method, pathName, body, requestOptions) {
    const opts = requestOptions || {};
    const url = this.baseUrl + '/' + String(pathName).replace(/^\/+/, '');
    const retries = opts.retries === undefined ? this.maxRetries : opts.retries;

    for (let attempt = 0; ; attempt++) {
      this._waitForBucket(method, pathName);

      let result;
      try {
        result = this._rawRequest(method, url, body);
      } catch (err) {
        if (attempt < retries) {
          sleepSync(this._backoff(attempt));
          continue;
        }
        throw err;
      }

      this._trackRateLimit(method, pathName, result.headers);

      if (result.statusCode === 429 && attempt < retries) {
        const retryAfter = parseFloat(result.headers['retry-after']);
        sleepSync(isNaN(retryAfter) ? this._backoff(attempt) : retryAfter * 1000);
        continue;
      }
      if (result.statusCode >= 500 && result.statusCode <= 599 && attempt < retries) {
        sleepSync(this._backoff(attempt));
        continue;
      }

      return result;
    }
  }

  _rawRequest(method, url, body, extraParts) {
    const timeoutSec = Math.max(1, Math.ceil(this.timeout / 1000));
    const parts = ['curl', '-sS', '--max-time', String(timeoutSec), '-D', '-', '-X', method];
    for (const [k, v] of Object.entries(this._headers())) {
      parts.push('-H', shellQuote(k + ': ' + v));
    }

    let tmp = null;
    if (body !== undefined && body !== null) {
      tmp = path.join(os.tmpdir(), 'elyxion-discord-' + Math.random().toString(36).slice(2) + '.json');
      fs.writeFileSync(tmp, typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
      parts.push('--data-binary', '@' + tmp);
    }

    if (extraParts) {
      for (const p of extraParts) parts.push(p);
    }

    parts.push('-w', shellQuote('\n%{http_code}'));
    parts.push(shellQuote(url));

    if (tmp) {
      parts.push(IS_WIN ? '&' : ';');
      parts.push(IS_WIN ? 'del /F /Q ' + shellQuote(tmp) + ' 2>nul' : 'rm -f ' + shellQuote(tmp));
    }

    let out;
    try {
      out = execSync(parts.join(' ')).toString('utf-8');
    } catch (err) {
      throw new Error('Discord API request failed (is curl installed?): ' + (err && err.message ? err.message : 'unknown error'));
    }

    // Output layout: HTTP headers, blank line, body, then the
    // trailing -w status line.
    let rest = out;
    let headBlock = '';
    const sep = rest.indexOf('\r\n\r\n');
    if (sep !== -1) {
      headBlock = rest.slice(0, sep);
      rest = rest.slice(sep + 4);
    } else {
      const sep2 = rest.indexOf('\n\n');
      if (sep2 !== -1) {
        headBlock = rest.slice(0, sep2);
        rest = rest.slice(sep2 + 2);
      }
    }
    const headers = parseHeaders(headBlock);

    const lines = rest.split('\n');
    const statusLine = lines.length ? lines.pop() : '';
    const bodyText = lines.join('\n');
    const statusCode = parseInt(statusLine.trim(), 10) || 0;

    let data = null;
    if (bodyText) {
      try {
        data = JSON.parse(bodyText);
      } catch (_) {
        data = bodyText;
      }
    }

    return { statusCode, data, body: bodyText, headers };
  }

  _backoff(attempt) {
    const base = Math.max(1, this.retryBackoff) * Math.pow(2, attempt);
    return Math.min(base, 15000) + Math.floor(Math.random() * 200);
  }

  _trackRateLimit(method, pathName, headers) {
    const bucket = headers['x-ratelimit-bucket'];
    const key = bucket || routeKey(method, pathName);
    const remaining = parseInt(headers['x-ratelimit-remaining'], 10);
    const reset = parseFloat(headers['x-ratelimit-reset']);
    const resetAfter = parseFloat(headers['x-ratelimit-reset-after']);
    let resetAt = 0;
    if (!isNaN(reset)) resetAt = reset * 1000;
    else if (!isNaN(resetAfter)) resetAt = Date.now() + resetAfter * 1000;

    if (resetAt > 0 || !isNaN(remaining)) {
      const state = {
        remaining,
        resetAt,
        limit: parseInt(headers['x-ratelimit-limit'], 10) || 0
      };
      this._buckets[key] = state;
      if (bucket) this._buckets[routeKey(method, pathName)] = state;

      // A global 429 applies to every bucket.
      if (headers['x-ratelimit-global'] === 'true' && resetAt > 0) {
        for (const k of Object.keys(this._buckets)) {
          if (k !== key) this._buckets[k].resetAt = Math.max(this._buckets[k].resetAt || 0, resetAt);
        }
      }
    }
  }

  _waitForBucket(method, pathName) {
    const state = this._buckets[routeKey(method, pathName)];
    if (!state || state.remaining !== 0) return;
    const wait = state.resetAt - Date.now();
    if (wait > 0) sleepSync(Math.min(wait + 100, 15000));
  }

  // ---- Message convenience --------------------------------------

  sendMessage(channelId, content) {
    return this.post('/channels/' + channelId + '/messages', content);
  }

  editMessage(channelId, messageId, content) {
    return this.patch('/channels/' + channelId + '/messages/' + messageId, content);
  }

  deleteMessage(channelId, messageId) {
    return this.del('/channels/' + channelId + '/messages/' + messageId);
  }

  // Multipart upload. `file` is { name, data, contentType }; `data`
  // may be a Buffer or string. Extra fields go in `options`:
  // { content, embeds, tts, ... }.
  sendFile(channelId, options) {
    options = options || {};
    const file = options.file;
    if (!file || file.data === undefined) {
      throw new Error('sendFile needs { file: { name, data, contentType } }');
    }

    const payloadJson = {};
    if (options.content !== undefined) payloadJson.content = options.content;
    if (options.embeds !== undefined) payloadJson.embeds = options.embeds;
    if (options.tts !== undefined) payloadJson.tts = options.tts;

    const tmp = path.join(os.tmpdir(), 'elyxion-discord-file-' + Math.random().toString(36).slice(2));
    let result;
    try {
      fs.writeFileSync(tmp, file.data);
      const type = file.contentType || 'application/octet-stream';
      const filename = file.name || 'file.bin';
      const url = this.baseUrl + '/channels/' + channelId + '/messages';
      const extra = [
        '-F', shellQuote('file=@' + tmp + ';filename=' + filename + ';type=' + type),
        '-F', shellQuote('payload_json=' + JSON.stringify(payloadJson))
      ];
      result = this._rawRequest('POST', url, null, extra);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    }
    this._trackRateLimit('POST', '/channels/' + channelId + '/messages', result.headers);
    return result;
  }

  get(pathName) { return this.request('GET', pathName); }
  post(pathName, body) { return this.request('POST', pathName, body); }
  put(pathName, body) { return this.request('PUT', pathName, body); }
  patch(pathName, body) { return this.request('PATCH', pathName, body); }
  del(pathName) { return this.request('DELETE', pathName); }
}

module.exports = {
  RestClient,
  DEFAULT_BASE_URL,
  routeKey,
  parseHeaders,
  sleepSync
};
