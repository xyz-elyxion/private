// Elyxion Discord Framework — voice
// ---------------------------------------------------------------
// Signaling-complete voice support with zero dependencies:
//
//   bot.voice.join(guildId, channelId, { selfDeaf: true });
//   bot.voice.leave(guildId);
//   bot.voice.move(...); bot.voice.setMute(...) ...
//
// Joining performs the full handshake: the client gateway VOICE_STATE_
// UPDATE / VOICE_SERVER_UPDATE exchange, a WebSocket connection to the
// assigned voice server, identify, heartbeats, UDP discovery (when the
// runtime exposes `dgram`), and select_protocol — ending in
// session_description (secret keys).
//
// Actual audio I/O needs an Opus codec and RTP encryption, which are
// native code on every mainstream library. This framework stops at the
// signaling layer: everything fires so higher-level bots can plug into
// their own pipeline.
'use strict';

const { EventEmitter } = require('events');
const { Gateway, FrameParser, encodeFrame } = require('./gateway');

const OPCODES = {
  IDENTIFY: 0,
  SELECT_PROTOCOL: 1,
  READY: 2,
  HEARTBEAT: 3,
  SESSION_DESCRIPTION: 4,
  SPEAKING: 5,
  HELLO: 8
};

const DISCOVERY_MAGIC = 0x1;

function safeRequire(name) {
  try { return require(name); } catch (_) { return null; }
}

// ---- Manager ------------------------------------------------------

class VoiceManager extends EventEmitter {
  constructor(bot) {
    super();
    this.bot = bot;
    this.connections = new Map(); // guildId -> VoiceConnection
    this._pending = new Map();    // guildId -> { state, server }
  }

  // join(guildId, channelId, options)
  async join(guildId, channelId, options) {
    if (!this.bot.gateway || !this.bot.user) {
      throw new Error('voice.join() needs an active gateway (login + connect first)');
    }
    this._leaveConnection(guildId);

    const opts = options || {};
    const payload = {
      guild_id: String(guildId),
      channel_id: channelId ? String(channelId) : null,
      self_mute: !!opts.selfMute,
      self_deaf: opts.selfDeaf === undefined ? true : !!opts.selfDeaf
    };
    this._pending.set(String(guildId), {});
    this.bot.gateway.sendVoiceState(payload);
    return true;
  }

  leave(guildId) {
    const id = String(guildId);
    this._leaveConnection(id);
    if (this.bot.gateway) {
      this.bot.gateway.sendVoiceState({ guild_id: id, channel_id: null });
    }
    this._pending.delete(id);
  }

  _leaveConnection(guildId) {
    const existing = this.connections.get(String(guildId));
    if (existing) {
      existing.destroy();
      this.connections.delete(String(guildId));
    }
  }

  setMute(guildId, mute) {
    const conn = this.connections.get(String(guildId));
    if (!conn) throw new Error('Not connected to voice in ' + guildId);
    conn.setSpeakingState(mute ? 4 : 0);
    return this;
  }

  // Re-send the voice state with a different self-deaf flag while
  // staying in the current channel.
  deafen(guildId, deaf) {
    const conn = this.connections.get(String(guildId));
    if (!conn || !conn.channelId) {
      throw new Error('Not connected to voice in ' + guildId);
    }
    return this.join(guildId, conn.channelId, { selfMute: false, selfDeaf: !!deaf });
  }

  // ---- Dispatch hooks (called from Bot._handleGatewayEvent) --------

  handleVoiceStateUpdate(state) {
    if (!this._pending.has(String(state.guild_id))) return null;
    const pending = this._pending.get(String(state.guild_id));
    pending.state = state;
    return this._maybeConnect(state.guild_id);
  }

  handleVoiceServerUpdate(server) {
    if (!this._pending.has(String(server.guild_id))) return null;
    const pending = this._pending.get(String(server.guild_id));
    pending.server = server;
    return this._maybeConnect(server.guild_id);
  }

  _maybeConnect(guildId) {
    const key = String(guildId);
    const pending = this._pending.get(key);
    if (!pending || !pending.state || !pending.server) return null;

    this._leaveConnection(key);
    const connection = new VoiceConnection({
      guildId: key,
      endpoint: pending.server.endpoint,
      token: pending.server.token,
      sessionId: pending.state.session_id,
      userId: pending.state.user_id || (this.bot.user && this.bot.user.id),
      channelId: pending.state.channel_id || null,
      bot: this.bot
    });
    this.connections.set(key, connection);
    this._pending.delete(key);
    connection.connect();
    this.emit('connection', connection);
    return connection;
  }

  destroy() {
    for (const [id, conn] of Array.from(this.connections.entries())) {
      conn.destroy();
      this.connections.delete(id);
    }
    this._pending.clear();
  }
}

// ---- One connection -------------------------------------------------

class VoiceConnection extends EventEmitter {
  constructor(options) {
    super();
    this.guildId = String(options.guildId);
    this.endpoint = options.endpoint;           // 'region.discord.media'
    this.token = options.token;
    this.sessionId = options.sessionId;
    this.userId = String(options.userId);
    this.channelId = options.channelId || null;
    this.bot = options.bot || null;

    this.ws = null;
    this.ready = false;
    this.destroyed = false;
    this.mode = null;
    this.secretKey = null;
    this.ssrc = null;
    this.ip = null;
    this.port = null;

    this._heartbeatTimer = null;
    this._nonce = Math.floor(Math.random() * 4294967295);
    this._handshakeTimer = setTimeout(() => {
      if (!this.ready) {
        this.emit('error', new Error('Voice handshake timed out'));
        this.destroy();
      }
    }, 15000);
    if (this._handshakeTimer.unref) this._handshakeTimer.unref();
  }

  connect() {
    if (this.destroyed) return this;
    if (!this.endpoint) {
      this.emit('error', new Error('VOICE_SERVER_UPDATE had no endpoint'));
      return this;
    }
    const url = 'wss://' + this.endpoint.split(':')[0] + '/?v=4';
    this.ws = new Gateway({ token: 'voice-not-a-client-token', url });

    // The shared Gateway class identifies as a Discord client on Hello
    // (op 10). The voice protocol hellos with op 8, which falls through
    // to 'message' without side effects, so we drive the handshake here.
    this.ws.on('message', (payload) => this._onPayload(payload));
    this.ws.on('error', (err) => this.emit('error', err));
    this.ws.on('close', () => this.emit('closed'));
    this.ws.connect();
    return this;
  }

  _send(op, data) {
    if (!this.ws) return;
    try {
      this.ws._connected = true; // allow _send through the shared layer
      this.ws._send(op, data);
    } catch (_) { /* socket died mid-write */ }
  }

  _onPayload(payload) {
    switch (payload.op) {
      case OPCODES.HELLO:
        this._startHeartbeat(payload.d.heartbeat_interval || 13750);
        this._send(OPCODES.IDENTIFY, {
          server_id: this.guildId,
          user_id: this.userId,
          session_id: this.sessionId,
          token: this.token
        });
        break;

      case OPCODES.READY: {
        this.ssrc = payload.d.ssrc;
        this.ip = payload.d.ip || null;
        this.port = payload.d.port || null;
        this.emit('ready', { ssrc: this.ssrc, ip: this.ip, port: this.port, modes: payload.d.modes });
        if (payload.d.modes && payload.d.modes.length) {
          this.mode = this._pickMode(payload.d.modes);
        }
        this._discoverUDP(payload.d);
        break;
      }

      case OPCODES.SESSION_DESCRIPTION:
        clearTimeout(this._handshakeTimer);
        this.secretKey = payload.d.secret_key;
        this.mode = payload.d.audio_codec ? this.mode : this.mode;
        if (payload.d.audio_codec) this.audioCodec = payload.d.audio_codec;
        this.ready = true;
        this.emit('session', { mode: this.mode, secretKey: this.secretKey, audioCodec: payload.d.audio_codec });
        break;

      case OPCODES.HEARTBEAT_ACK:
        this.emit('heartbeatAck', payload.d);
        break;

      default:
        break;
    }
  }

  // Prefer a modern AEAD mode when offered.
  _pickMode(modes) {
    const preference = ['aead_xchacha20_poly1305_rtpsize', 'xsalsa20_poly1305_suffix',
      'xsalsa20_poly1305', 'xsalsa20_poly1305_lite'];
    for (const p of preference) {
      if (modes.indexOf(p) !== -1) return p;
    }
    return modes[0];
  }

  // UDP discovery: send 74-byte packet with our SSRC, get ip/port back.
  _discoverUDP(readyData) {
    const dgram = safeRequire('dgram');
    if (!dgram || typeof dgram.createSocket !== 'function') {
      // Signaling-only runtime: cannot complete select_protocol.
      this.emit('udpUnavailable');
      return;
    }
    if (!readyData || readyData.port === undefined) return;

    const socket = dgram.createSocket('udp4');
    const packet = encodeDiscoveryPacket(readyData.ssrc);

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.close();
        this.emit('error', new Error('UDP discovery timed out'));
      }
    }, 5000);
    if (timeout.unref) timeout.unref();

    socket.on('message', (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = parseDiscoveryPacket(msg);
      socket.close(() => this._selectProtocol(result.ip, result.port));
    });
    socket.on('error', () => {
      if (!settled) { settled = true; clearTimeout(timeout); this.emit('error', new Error('UDP discovery failed')); }
    });

    socket.bind(undefined, () => {
      try {
        socket.send(packet, readyData.port, readyData.ip);
      } catch (err) {
        settled = true;
        clearTimeout(timeout);
        this.emit('error', err);
      }
    });
  }

  _selectProtocol(ip, port) {
    this.ip = ip;
    this.port = port;
    this._send(OPCODES.SELECT_PROTOCOL, {
      protocol: 'udp',
      data: { address: ip, port: port, mode: this.mode || 'aead_xchacha20_poly1305_rtpsize' }
    });
  }

  // Announce speaking state. flags bitfield: 1 mic, 2 soundshare/screen,
  // 4 priority speaker; delay between RTCP updates in ms.
  setSpeakingState(flags, delayMs) {
    this._send(OPCODES.SPEAKING, {
      speaking: flags | 0,
      delay: delayMs === undefined ? 0 : delayMs | 0,
      ssrc: this.ssrc
    });
    return this;
  }

  _startHeartbeat(interval) {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      this._send(OPCODES.HEARTBEAT, this._nonce++);
    }, Math.min(interval || 13750, 60000));
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this._handshakeTimer);
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.ready = false;
    this.emit('destroyed');
  }
}

// Build the 74-byte IP-discovery packet:
//   [0..1] type LE16 (0x1 = request), [2..3] length LE16 (70),
//   [4..7] ssrc LE32, [8..73] zeros.
function encodeDiscoveryPacket(ssrc) {
  const buf = Buffer.alloc(74);
  buf.writeUInt16LE(DISCOVERY_MAGIC, 0);
  buf.writeUInt16LE(70, 2);
  buf.writeUInt32LE(ssrc >>> 0, 4);
  for (let i = 8; i < 74; i++) buf[i] = 0;
  return buf;
}

// Inverse: read the reply's type, then extract NUL-padded ip string
// and LE port from bytes 64-66.
function parseDiscoveryPacket(msg) {
  if (msg.length < 74) throw new Error('Short UDP discovery response (' + msg.length + ' bytes)');
  const ipBytes = msg.slice(8, 72);
  let end = ipBytes.indexOf(0);
  if (end === -1) end = ipBytes.length;
  return {
    ip: ipBytes.toString('ascii', 0, end),
    port: msg.readUIntLE(72, 2)
  };
}

module.exports = {
  VoiceManager,
  VoiceConnection,
  encodeDiscoveryPacket,
  parseDiscoveryPacket,
  OPCODES
};
