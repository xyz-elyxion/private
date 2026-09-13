// Anticheat console test harness (dev only).
//
// Paste this file's contents into the browser console while playing on YOUR OWN
// dev server, then call the `ac` helpers. Each helper deliberately violates one
// server-side guard in server/elyxion-game.ts so you can confirm the violation
// lands in the /admin → "Anticheat & Bans" audit trail and that the guard
// behaves as intended.
//
// ⚠️ Auto-ban: 12 violations within 10 minutes triggers a 24h auto-ban on your
// account. Run a couple of tests per session, or clear your dev DB between
// runs. Never use this on a public server — it's for verifying your own guards.
//
// How it works: every client → server message goes through the game's outbound
// send path, so we shim `WebSocket.prototype.send` and let you forge raw
// `shoot` JSON payloads (or binary `pos` frames) the server will accept.

(function () {
  if (window.__acHarness) return console.warn('[ac] already installed');

  const REAL_SEND = WebSocket.prototype.send;
  const origSend = function (data) {
    if (window.__acIntercept && window.__acFilter && !window.__acFilter(data)) {
      return; // swallowed — never reaches the server
    }
    return REAL_SEND.call(this, data);
  };
  WebSocket.prototype.send = origSend;

  const socket = () => {
    // The game keeps one WS; find it among open sockets.
    for (const key of Object.keys(window)) {
      const v = window[key];
      if (v instanceof WebSocket && v.readyState === WebSocket.OPEN) return v;
    }
    return null;
  };

  const ac = {
    // Stop the real game from sending while a test runs (so forged packets are
    // the only traffic). Pass false to release.
    hold(on = true) {
      window.__acIntercept = on;
      console.log(`[ac] outbound traffic ${on ? 'HELD' : 'released'}`);
    },

    // Send a forged `shoot` JSON message.
    shoot(overrides = {}) {
      const ws = socket();
      if (!ws) return console.warn('[ac] no open game socket');
      const base = {
        type: 'shoot',
        ox: 0, oy: 2, oz: 0,
        dx: 1, dy: 0, dz: 0,
        maxDist: 200,
        renderTime: Date.now(),
        ...overrides,
      };
      REAL_SEND.call(ws, JSON.stringify(base));
    },

    // 1) Fire-rate gate: bursts shots faster than RAIL_COOLDOWN (1.2s − 80ms
    //    tolerance). Each accepted-too-early shot logs a `fire_rate` violation
    //    AND the shot is dropped.
    testFireRate(n = 3) {
      this.hold(true);
      let i = 0;
      const t = setInterval(() => {
        if (i++ >= n) { clearInterval(t); this.hold(false); return; }
        this.shoot({ renderTime: Date.now() });
        console.log(`[ac] fire_rate shot ${i}/${n}`);
      }, 200); // ~0.2s apart, way under the 1.12s floor
    },

    // 2) Shot-origin sanity: fires from an origin > 3m from the server's
    //    authoritative eye position. Logs `shot_origin`.
    testShotOrigin(distMeters = 8) {
      this.hold(true);
      this.shoot({ ox: distMeters, oy: 2 + distMeters, oz: distMeters, renderTime: Date.now() });
      console.log(`[ac] shot_origin fired from ~${Math.round(distMeters * 1.73)}m off eye`);
      setTimeout(() => this.hold(false), 50);
    },

    // 3) Rewind clamp: requests a renderTime far in the past (server clamps to
    //    now − 350ms). Should NOT log a violation (it's silently clamped) —
    //    this test just verifies the clamp, hits still resolve sanely.
    testRewindClamp(msBack = 5000) {
      this.hold(true);
      this.shoot({ renderTime: Date.now() - msBack });
      console.log(`[ac] rewind clamp: renderTime ${msBack}ms in the past (expect silent clamp)`);
      setTimeout(() => this.hold(false), 50);
    },

    // 4) Move-speed clamp: forges a binary `pos` frame implying horizontal
    //    speed > MAX_MOVE_SPEED (80 m/s). Logs `move_speed`. The pos frame is
    //    21 bytes (netcodec encodePos); we hand-roll a plausible one here —
    //    if your codec layout differs, swap in `encodePos` from the game.
    testMoveSpeed() {
      this.hold(true);
      const ws = socket();
      if (!ws) return console.warn('[ac] no open game socket');
      // Simplest reliable path: reuse the game's own encoder if reachable.
      // The bundled client exposes it via the module graph; fall back to a
      // raw buffer of zeros (server will read garbage coords ≈ huge delta).
      const buf = new Uint8Array(21);
      buf[0] = 0x02; // pos frame marker — adjust if netcodec uses a different op byte
      REAL_SEND.call(ws, buf);
      console.log('[ac] move_speed: garbage pos frame sent (expect a violation or silent drop)');
      setTimeout(() => this.hold(false), 50);
    },

    // 5) Flood guard: spams > 150 inbound messages/sec → the server closes the
    //    socket. ⚠️ This disconnects you from the match — reconnect after.
    testFlood(seconds = 2) {
      const ws = socket();
      if (!ws) return console.warn('[ac] no open game socket');
      console.log('[ac] flood: spamming pings (socket will be closed by the server)…');
      const t0 = performance.now();
      (function burst() {
        while (performance.now() - t0 < seconds * 1000) {
          REAL_SEND.call(ws, JSON.stringify({ type: 'ping', ts: Date.now(), rtt: 0 }));
        }
      })();
    },

    // Inspect the current guards' effective constants (mirrors the server).
    info() {
      console.table({
        fire_rate_floor_ms: 1120,        // RAIL_COOLDOWN*1000 − 80
        shot_origin_max_dist_m: 3,       // SHOT_ORIGIN_MAX_DIST
        max_move_speed_mps: 80,          // MAX_HORIZONTAL_SPEED(50) * 1.6
        max_vertical_speed_mps: 80,      // MAX_VERTICAL_SPEED
        max_rewind_ms: 350,              // MAX_REWIND_MS
        msg_rate_limit: 150,             // MSG_RATE_LIMIT /sec
        auto_ban: '12 violations / 10 min → 24h ban',
      });
    },
  };

  window.__acHarness = true;
  window.ac = ac;
  console.log('%c[ac] anticheat test harness installed — try ac.info(), ac.testFireRate(2), ac.testShotOrigin(8)…',
    'color:#22d3ee');
  console.log('%c[ac] REMINDER: 12 violations in 10 min auto-bans this account for 24h. Dev server only.',
    'color:#fbbf24');
})();
