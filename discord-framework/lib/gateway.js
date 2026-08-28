// Elyxion Discord Framework — gateway (WebSocket) client
// ---------------------------------------------------------------
// Implements the Discord gateway protocol (RFC 6455 WebSocket over
// TLS, opcode framing, Identify, heartbeat, resume, presence, and
// optional zlib-stream compression) directly on the runtime's
// tls/net/zlib modules — no dependencies.
//
//   const gw = new Gateway({ token, intents: ['GUILDS', 'GUILD_MESSAGES'] });
//   gw.on('message', (payload) => ...);   // { op, t, d, s }
//   gw.on('ready', (data) => ...);        // READY dispatch
//   gw.on('reconnecting', (info) => ...); // auto-reconnect in progress
//   gw.connect();
'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

const DEFAULT_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// ---- Intents ----------------------------------------------------

const INTENT_BITS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MODERATION: 1 << 2,
  GUILD_EMOJIS_AND_STICKERS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15,
  GUILD_SCHEDULED_EVENTS: 1 << 16,
  AUTO_MODERATION_CONFIGURATION: 1 << 20,
  AUTO_MODERATION_EXECUTION: 1 << 21
};

// A bot that only reads messages needs these plus MESSAGE_CONTENT.
const DEFAULT_INTENTS = ['GUILDS', 'GUILD_MESSAGES', 'DIRECT_MESSAGES', 'MESSAGE_CONTENT'];

function intentBits(names) {
  let bits = 0;
  for (const name of names || []) {
    const bit = INTENT_BITS[name.toUpperCase()];
    if (bit !== undefined) bits |= bit;
  }
  return bits;
}

// ---- RFC 6455 framing -------------------------------------------

// Random bytes with a Math.random fallback (the runtime's crypto
// may not expose randomBytes on every build).
function randomBytes(n) {
  if (crypto && typeof crypto.randomBytes === 'function') {
    try { return crypto.randomBytes(n); } catch (_) {}
  }
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

// Big-endian 64-bit helpers (avoid BigInt for runtime compatibility).
function writeUInt64(buf, value, offset) {
  for (let i = 7; i >= 0; i--) {
    buf[offset + i] = value & 0xff;
    value = Math.floor(value / 256);
  }
}

function readUInt64(buf, offset) {
  let value = 0;
  for (let i = 0; i < 8; i++) value = value * 256 + buf[offset + i];
  return value;
}

// Encodes a WebSocket frame. Client frames are masked by default.
//   encodeFrame('hello') -> Buffer
//   encodeFrame(Buffer, { opcode: 2, mask: false }) -> Buffer
function encodeFrame(data, options) {
  options = options || {};
  const opcode = options.opcode === undefined ? 1 : options.opcode;
  const mask = options.mask === undefined ? true : !!options.mask;
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;

  let header;
  let len = buf.length;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    writeUInt64(header, len, 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode

  if (mask) {
    header[1] |= 0x80;
    const key = randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = buf[i] ^ key[i % 4];
    return Buffer.concat([header, key, masked]);
  }
  return Buffer.concat([header, buf]);
}

// Incremental frame parser. Feed it socket chunks; it returns the
// complete frames found so far and keeps leftover bytes buffered.
class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;

    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = readUInt64(buf, 2);
      offset = 10;
    }

    let key = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      key = buf.slice(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;

    let payload = buf.slice(offset, offset + len);
    if (masked && key) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ key[i % 4];
      payload = unmasked;
    }

    this.buffer = buf.slice(offset + len);
    return { fin, opcode, payload };
  }
}

// ---- Gateway client ---------------------------------------------

class Gateway extends EventEmitter {
  constructor(options = {}) {
    super();
    this.token = options.token || null;
    this.url = options.url || DEFAULT_URL;
    this.compress = !!options.compress;
    this.intents = options.intents || DEFAULT_INTENTS.slice();
    this.shard = options.shard || null; // [id, count]
    this.maxReconnects = options.maxReconnects === undefined ? 10 : options.maxReconnects;

    this._socket = null;
    this._parser = new FrameParser();
    this._inflate = null;
    this._heartbeatTimer = null;
    this._heartbeatAck = true;
    this._sequence = null;

    // Session state (used for resume).
    this.session_id = null;
    this.user = null;

    this._connected = false;
    this._closed = false;
    this._intentionalClose = false;
    this._handshakeDone = false;
    this._httpBuffer = '';
    this._resumeRequested = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._reconnectDelay = 1000;
  }

  connect() {
    if (this._socket) return this;
    if (!this.token) throw new Error('Gateway needs a token before connecting');

    const zlib = safeRequire('zlib');
    if (this.compress && !zlib) {
      throw new Error('Gateway compression requested but zlib is unavailable on this runtime');
    }

    this._closed = false;
    this._intentionalClose = false;

    const { hostname, port, secure } = parseWsUrl(this._effectiveUrl());
    const tls = safeRequire('tls');
    const net = safeRequire('net');
    const connectFn = secure && tls && typeof tls.connect === 'function' ? tls.connect : net.connect;

    const socket = connectFn({ host: hostname, port: port }, () => {
      // HTTP/1.1 Upgrade handshake
      const key = randomBytes(16).toString('base64');
      this._handshakeKey = key;
      socket.write(
        'GET ' + pathOf(this._effectiveUrl()) + ' HTTP/1.1\r\n' +
        'Host: ' + hostname + ':' + port + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n'
      );
    });

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => this._onSocketClose());

    this._socket = socket;
    this._handshakeDone = false;
    this._httpBuffer = '';
    return this;
  }

  _effectiveUrl() {
    if (this.compress && this.url.indexOf('compress=') === -1) {
      return this.url + (this.url.indexOf('?') === -1 ? '?' : '&') + 'compress=zlib-stream';
    }
    return this.url;
  }

  _onData(chunk) {
    // First, complete the HTTP 101 handshake.
    if (!this._handshakeDone) {
      this._httpBuffer += chunk;
      const idx = this._httpBuffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = this._httpBuffer.substring(0, idx);
      this._httpBuffer = this._httpBuffer.substring(idx + 4);
      this._handshakeDone = true;
      if (!/^HTTP\/1\.1 101/i.test(head)) {
        this.emit('error', new Error('Gateway handshake failed: ' + head.split('\r\n')[0]));
        this.close();
        return;
      }
      this._setupInflate();
      // Any bytes after the handshake are already WebSocket frames.
      if (this._httpBuffer) this._feedRaw(this._httpBuffer);
      this._httpBuffer = '';
      return;
    }
    this._feedRaw(chunk);
  }

  // Route raw socket bytes: through the inflater when compressed,
  // straight to the frame parser otherwise.
  _feedRaw(data) {
    if (this._inflate) {
      try {
        this._inflate.write(data);
      } catch (err) {
        this.emit('error', err);
        this.close();
      }
      return;
    }
    this._feed(data);
  }

  _setupInflate() {
    if (!this.compress) return;
    const zlib = safeRequire('zlib');
    if (!zlib || typeof zlib.createInflate !== 'function') {
      this.emit('error', new Error('Gateway compression requested but zlib is unavailable'));
      this.close();
      return;
    }
    this._inflate = zlib.createInflate({ chunkSize: 128 * 1024 });
    this._inflate.on('data', (buf) => this._feed(buf));
    this._inflate.on('error', (err) => {
      this.emit('error', err);
      this.close();
    });
  }

  _feed(data) {
    for (const frame of this._parser.push(data)) {
      this._onFrame(frame);
    }
  }

  _onFrame(frame) {
    if (frame.opcode === 0x8) { // close
      this.close();
      return;
    }
    if (frame.opcode === 0x9) { // ping -> pong
      this._write(encodeFrame(frame.payload, { opcode: 0xa }));
      return;
    }
    if (frame.opcode === 0xa) return; // pong
    if (frame.opcode !== 0x1 && frame.opcode !== 0x2) return;

    const text = String(frame.payload);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      this.emit('error', new Error('Gateway sent invalid JSON: ' + text.slice(0, 120)));
      return;
    }

    if (payload.s !== undefined && payload.s !== null) this._sequence = payload.s;
    this.emit('message', payload);

    switch (payload.op) {
      case 0: // dispatch
        if (payload.t === 'READY') {
          this.session_id = payload.d.session_id || null;
          this.user = payload.d.user || null;
          this._reconnectAttempts = 0;
          this._reconnectDelay = 1000;
          this.emit('ready', payload.d);
        }
        break;
      case 1: // heartbeat request
        this._send(1, this._sequence);
        break;
      case 10: // Hello — identify or resume, then heartbeat
        this._connected = true;
        this.emit('hello', payload.d);
        this.emit('connected');
        this._startHeartbeat((payload.d && payload.d.heartbeat_interval) || 41250);
        if (this._resumeRequested && this.session_id && this._sequence !== null) this.resume();
        else this.identify();
        this._resumeRequested = false;
        break;
      case 11: // Heartbeat ACK
        this._heartbeatAck = true;
        break;
      case 7: // Reconnect — close and reconnect with resume
        this.emit('reconnect');
        this._teardown();
        this._emitReconnect(true);
        break;
      case 9: // Invalid session
        if (payload.d === true) {
          this._emitReconnect(true);
        } else {
          this.session_id = null;
          this._sequence = null;
          this._emitReconnect(false);
        }
        break;
      default:
        break;
    }
  }

  identify() {
    this._send(2, {
      token: this.token,
      intents: intentBits(this.intents),
      properties: {
        os: 'elyxion',
        browser: 'elyxion-discord',
        device: 'elyxion-discord'
      },
      shard: this.shard
    });
  }

  // Resume an existing session (op 6) after a reconnect.
  resume() {
    this._send(6, {
      token: this.token,
      session_id: this.session_id,
      seq: this._sequence
    });
  }

  // Update presence (op 3): { status, activities, afk, since }.
  setPresence(presence) {
    presence = presence || {};
    const data = {
      since: presence.since === undefined ? null : presence.since,
      activities: presence.activities || [],
      status: presence.status || 'online',
      afk: !!presence.afk
    };
    this._send(3, data);
    return this;
  }

  // Voice state update (op 4): join/move/leave a voice channel and
  // toggle self mute/deafen. Payload: { guild_id, channel_id,
  // self_mute, self_deaf } (channel_id null leaves voice).
  sendVoiceState(state) {
    this._send(4, {
      guild_id: String(state.guild_id),
      channel_id: state.channel_id ? String(state.channel_id) : null,
      self_mute: !!state.self_mute,
      self_deaf: !!state.self_deaf
    });
    return this;
  }

  // Request guild member chunks (op 8). The gateway responds with
  // GUILD_MEMBERS_CHUNK dispatches. Needs the GUILD_MEMBERS intent
  // for offline members. Pass { guild_id, query, limit } — query ''
  // with limit 0 fetches everyone (privileged intent required).
  requestGuildMembers(request) {
    const payload = Object.assign({ limit: 0 }, request);
    if (!payload.guild_id) throw new Error('requestGuildMembers needs a guild_id');
    if (payload.query === undefined) payload.query = '';
    if (Array.isArray(payload.user_ids)) {
      delete payload.query;
      payload.user_ids = payload.user_ids.map(String);
    }
    this._send(8, payload);
    return this;
  }

  _startHeartbeat(interval) {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (!this._heartbeatAck) {
        this.emit('error', new Error('Gateway heartbeat timed out'));
        this._teardown();
        this._emitReconnect(true);
        return;
      }
      this._heartbeatAck = false;
      this._send(1, this._sequence);
    }, interval);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  _send(op, data) {
    if (!this._connected) return;
    this._write(encodeFrame(JSON.stringify({ op, d: data === undefined ? null : data })));
  }

  _write(buf) {
    if (this._socket && this._socket.writable !== false) {
      try { this._socket.write(buf); } catch (_) {}
    }
  }

  // ---- Reconnection ---------------------------------------------

  _emitReconnect(resume) {
    this._resumeRequested = resume;
    if (this._reconnectTimer) return;
    this._reconnectAttempts++;
    if (this.maxReconnects > 0 && this._reconnectAttempts > this.maxReconnects) {
      this._closed = true;
      this.emit('close');
      return;
    }
    const delay = this._nextDelay();
    this.emit('reconnecting', { delay, attempt: this._reconnectAttempts });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      try {
        this.connect();
      } catch (err) {
        this.emit('error', err);
      }
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _nextDelay() {
    const base = Math.min(this._reconnectDelay, 30000);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
    return base + Math.floor(Math.random() * base * 0.2);
  }

  _teardown() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._socket) {
      try { this._socket.end(); } catch (_) {}
      try { this._socket.destroy(); } catch (_) {}
      this._socket = null;
    }
    if (this._inflate) {
      try { this._inflate.destroy(); } catch (_) {}
      this._inflate = null;
    }
    this._parser = new FrameParser();
    this._handshakeDone = false;
    this._httpBuffer = '';
    this._connected = false;
  }

  _onSocketClose() {
    this._socket = null;
    if (this._intentionalClose || this._closed) return;
    this.emit('close');
    this._emitReconnect(true);
  }

  close() {
    this._intentionalClose = true;
    this._teardown();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (!this._closed) {
      this._closed = true;
      this.emit('close');
    }
  }
}

// ---- URL helpers ------------------------------------------------

function parseWsUrl(url) {
  const m = String(url || '').match(/^(wss?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/);
  if (!m) throw new Error('Invalid WebSocket URL: ' + url);
  const secure = m[1] === 'wss';
  return {
    secure,
    hostname: m[2],
    port: parseInt(m[3] || (secure ? 443 : 80), 10),
    pathname: m[4] || '/'
  };
}

function pathOf(url) {
  const m = String(url || '').match(/^(?:wss?):\/\/[^/]+(\/.*)?$/);
  return (m && m[1]) || '/';
}

function safeRequire(name) {
  try { return require(name); } catch (_) { return null; }
}

module.exports = { Gateway, FrameParser, encodeFrame, intentBits, INTENT_BITS };
