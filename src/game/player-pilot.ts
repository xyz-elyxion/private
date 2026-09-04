// "Let the AI play for you" — an admin-only spectate mode where the shared duel
// brain (rl-brain.ts) drives the LOCAL PLAYER slot instead of a human, while the
// same brain runs the enemy LearningBot. Each watched match is therefore a
// self-play training episode for the shared brain (the enemy bot's episode is
// reported exactly like a normal duel).
//
// The pilot is the mirror image of LearningBot: it samples the SAME low-level
// policy inputs (forward/strafe axes + jump/fire/dash/boost presses) and
// translates them into the InputState the Player physics consumes. There is no
// mouse — the pilot aims by setting player.yaw/pitch directly, then the rail
// resolves through the normal handleFire() path.
//
// Frame note: the bot's `facing` and the player's `yaw` use OPPOSITE zero
// directions (facing 0 → +z; yaw 0 → −z, three.js YXZ), so the bearing
// features are adapted here — cosB is negated so "target dead ahead" still
// reads +1 for the policy, keeping the feature distribution identical to what
// the brain was trained on.

import type { Player } from './player';
import { rayAabb, type ArenaMap } from './map';
import {
  BOOST_COOLDOWN,
  BOT_HEIGHT,
  DASH_COOLDOWN,
  EYE_HEIGHT,
  PITCH_LIMIT,
  RAIL_COOLDOWN,
} from './constants';
import {
  AIM_SPAN,
  AIM_SPAN_V,
  RL_DECIDE_INTERVAL,
  RL_FEATURE_COUNT,
  rlDecide,
  type RlBrain,
} from './rl-brain';
import type { InputState, Vec3 } from './types';

export type PilotTarget = { id: string; pos: Vec3 };

// The same engagement gate the LearningBot was trained under: only act on a
// visible enemy within range. Feeding out-of-distribution states (target behind
// a wall, across the map) teaches the policy nothing and looks broken.
const ENGAGE_RANGE = 55;
const AIM_LERP = 10; // smooth-pursuit turn rate (1/s), mirrors RL_FACING_LERP
const AIM_NOISE = 0.015; // radians of per-decision aim wobble (the skill floor)
const STICK_DEADZONE = 0.15;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrapPi = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const lerpAngle = (a: number, b: number, t: number) => a + wrapPi(b - a) * t;

const IDLE_INPUT: InputState = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  jumpPressed: false,
  dash: false,
  dashPressed: false,
  boost: false,
  boostPressed: false,
  fire: false,
  firePressed: false,
  zoom: false,
  crouch: false,
  slidePressed: false,
  scoreboard: false,
  chatPressed: false,
  yawDelta: 0,
  pitchDelta: 0,
};

export class PlayerPilot {
  private brain: RlBrain;
  private actTimer = 0; // countdown to the next policy decision
  private curF = 0; // forward axis held between decisions (−1..1)
  private curS = 0; // strafe axis held between decisions (−1..1)
  private curAimX = 0; // learned aim-point offset, lateral (held between decisions)
  private curAimY = 0; // learned aim-point offset, vertical
  private recentDeath = 0; // 1 for ~1s after dying (lets the policy "feel" pain)
  private noiseYaw = 0;
  private noisePitch = 0;
  private lastTgtId: string | null = null;
  private lastTgtPos: Vec3 = { x: 0, y: 0, z: 0 };
  private tgtSpeed = 0;
  // Wander state used while no enemy is visible — the pilot keeps moving (it
  // never freezes waiting for someone to come into view).
  private roamTarget: { x: number; z: number } | null = null;
  private roamTimer = 0;

  constructor(brain: RlBrain) {
    this.brain = brain;
    this.actTimer = 0.05 + Math.random() * 0.2; // desync the first decision
  }

  // Fresh match state (a new Game instance constructs a fresh pilot anyway).
  reset() {
    this.actTimer = 0.05 + Math.random() * 0.2;
    this.curF = 0;
    this.curS = 0;
    this.curAimX = 0;
    this.curAimY = 0;
    this.recentDeath = 0;
    this.noiseYaw = 0;
    this.noisePitch = 0;
    this.lastTgtId = null;
    this.tgtSpeed = 0;
    this.roamTarget = null;
    this.roamTimer = 0;
  }

  // The local player just died — feed the policy the "pain" signal (the same
  // recentDeath feature LearningBot gets from onDied()).
  onDeath() {
    this.recentDeath = 1;
  }

  // Advance one sim tick. Returns the InputState to feed Player.step (and whose
  // firePressed drives handleFire). Sets player.yaw/pitch to aim at the enemy.
  tick(dt: number, player: Player, target: PilotTarget | null, map: ArenaMap, railCd: number): InputState {
    if (this.recentDeath > 0) this.recentDeath = Math.max(0, this.recentDeath - dt);
    if (this.actTimer > 0) this.actTimer -= dt;

    // No visible in-range enemy: keep moving (wander the arena — never a frozen
    // statue waiting for someone to walk into view).
    if (!target || !this.engaged(player, target, map)) {
      this.lastTgtId = null;
      return this.roamTick(dt, player, map);
    }

    // Turn toward the policy's chosen AIM POINT (enemy chest + learned offsets),
    // with a small per-decision wobble — exactly like the LearningBot: the aim
    // is learned, and a shot only lands if the aim is actually on the enemy.
    const want = this.aimAngles(player, target);
    const t = 1 - Math.exp(-AIM_LERP * dt);
    player.yaw = lerpAngle(player.yaw, want.yaw + this.noiseYaw, t);
    player.pitch = clamp(player.pitch + (want.pitch + this.noisePitch - player.pitch) * t, -PITCH_LIMIT, PITCH_LIMIT);

    // Enemy lateral speed (the same tracking LearningBot feeds its features).
    if (this.lastTgtId === target.id && dt > 1e-4) {
      this.tgtSpeed =
        Math.hypot(target.pos.x - this.lastTgtPos.x, target.pos.z - this.lastTgtPos.z) / dt;
    }
    this.lastTgtId = target.id;
    this.lastTgtPos = { x: target.pos.x, y: target.pos.y, z: target.pos.z };

    // The policy's state snapshot (same 13 features LearningBot sees).
    const feats = this.features(player, target, railCd);

    let f = this.curF;
    let s = this.curS;
    let jumpP = false;
    let fireP = false;
    let dashP = false;
    let boostP = false;
    let crouch = false;
    let slideP = false;
    if (this.actTimer <= 0) {
      this.actTimer = RL_DECIDE_INTERVAL * (0.75 + Math.random() * 0.5);
      const d = rlDecide(this.brain.weights, feats, Math.random);
      f = this.curF = d.f;
      s = this.curS = d.s;
      this.curAimX = d.aimX;
      this.curAimY = d.aimY;
      jumpP = d.jump;
      fireP = d.fire;
      dashP = d.dash;
      boostP = d.boost;
      // Keep the learned pilot compatible with the expanded input shape; its
      // existing policy does not train stance actions yet.
      crouch = false;
      slideP = false;
      this.noiseYaw = (Math.random() - 0.5) * 2 * AIM_NOISE;
      this.noisePitch = (Math.random() - 0.5) * 2 * AIM_NOISE;
    }

    return {
      forward: f > STICK_DEADZONE,
      back: f < -STICK_DEADZONE,
      left: s < -STICK_DEADZONE,
      right: s > STICK_DEADZONE,
      jump: jumpP,
      jumpPressed: jumpP,
      dash: dashP,
      dashPressed: dashP,
      boost: boostP,
      boostPressed: boostP,
      fire: fireP,
      firePressed: fireP,
      zoom: false,
      crouch,
      slidePressed: slideP,
      scoreboard: false,
      chatPressed: false,
      yawDelta: 0,
      pitchDelta: 0,
    };
  }

  private engaged(player: Player, target: PilotTarget, map: ArenaMap): boolean {
    const dist = Math.hypot(target.pos.x - player.pos.x, target.pos.z - player.pos.z);
    if (dist > ENGAGE_RANGE) return false;
    return this.hasLineOfSight(player, target, map);
  }

  // Raycast eye → target chest against the map; blocked if a box is hit first.
  private hasLineOfSight(player: Player, target: PilotTarget, map: ArenaMap): boolean {
    const eye = { x: player.pos.x, y: player.pos.y + EYE_HEIGHT, z: player.pos.z };
    const tc = { x: target.pos.x, y: target.pos.y + BOT_HEIGHT * 0.5, z: target.pos.z };
    const dx = tc.x - eye.x;
    const dy = tc.y - eye.y;
    const dz = tc.z - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3) return true;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    for (const b of map.boxes) {
      const t = rayAabb(eye, dir, b);
      if (t !== null && t > 0.05 && t < dist - 0.3) return false;
    }
    return true;
  }

  // The point the policy chose to look at: the enemy's chest plus the learned
  // aim offsets (lateral metres perpendicular to the sightline + vertical).
  private aimPoint(player: Player, target: PilotTarget): Vec3 {
    const dx = target.pos.x - player.pos.x;
    const dz = target.pos.z - player.pos.z;
    const horiz = Math.hypot(dx, dz) || 1;
    const rx = -dz / horiz; // right of the sightline (sign is just convention)
    const rz = dx / horiz;
    return {
      x: target.pos.x + rx * this.curAimX * AIM_SPAN,
      y: target.pos.y + BOT_HEIGHT * 0.5 + this.curAimY * AIM_SPAN_V,
      z: target.pos.z + rz * this.curAimX * AIM_SPAN,
    };
  }

  // Yaw/pitch that aim the player at the policy's aim point (three.js YXZ
  // convention: forward = (0,0,−1) at yaw/pitch 0).
  private aimAngles(player: Player, target: PilotTarget): { yaw: number; pitch: number } {
    const ap = this.aimPoint(player, target);
    const dx = ap.x - player.pos.x;
    const dy = ap.y - (player.pos.y + EYE_HEIGHT);
    const dz = ap.z - player.pos.z;
    const horiz = Math.hypot(dx, dz) || 1e-6;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, horiz) };
  }

  // ── Wander (no enemy visible) ─────────────────────────────────────────────
  // Face + walk toward a wandering point inside the arena; pick a new one when
  // reached (or after a few seconds stuck against a wall). Keeps the pilot
  // alive and moving instead of freezing when nobody is in view.
  private roamTick(dt: number, player: Player, map: ArenaMap): InputState {
    this.roamTimer -= dt;
    if (
      !this.roamTarget ||
      this.roamTimer <= 0 ||
      Math.hypot(this.roamTarget.x - player.pos.x, this.roamTarget.z - player.pos.z) < 1.5
    ) {
      this.pickRoamTarget(map);
    }
    if (!this.roamTarget) return { ...IDLE_INPUT };
    const wantYaw = Math.atan2(
      -(this.roamTarget.x - player.pos.x),
      -(this.roamTarget.z - player.pos.z),
    );
    const t = 1 - Math.exp(-AIM_LERP * dt);
    player.yaw = lerpAngle(player.yaw, wantYaw, t);
    return { ...IDLE_INPUT, forward: true };
  }

  private pickRoamTarget(map: ArenaMap) {
    const b = map.bounds;
    const spanX = b.max.x - b.min.x;
    const spanZ = b.max.z - b.min.z;
    if (spanX < 6 || spanZ < 6) {
      this.roamTarget = {
        x: (b.min.x + b.max.x) / 2,
        z: (b.min.z + b.max.z) / 2,
      };
    } else {
      this.roamTarget = {
        x: b.min.x + 3 + Math.random() * (spanX - 6),
        z: b.min.z + 3 + Math.random() * (spanZ - 6),
      };
    }
    this.roamTimer = 5; // re-pick even if still walking (unsticks walls)
  }

  // The same 13 normalized features as LearningBot.combatFeatures, read from the
  // player's perspective (see the frame note at the top of this file).
  private features(player: Player, target: PilotTarget, railCd: number): number[] {
    const dx = target.pos.x - player.pos.x;
    const dz = target.pos.z - player.pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const ux = dx / dist;
    const uz = dz / dist;
    const sinY = Math.sin(player.yaw);
    const cosY = Math.cos(player.yaw);
    const cosB = -(ux * sinY + uz * cosY); // player yaw 0 → −z, so negate vs bot facing
    const sinB = ux * cosY - uz * sinY;
    // Player-yaw convention: the yaw that faces the target is atan2(−dx,−dz)
    // (forward = (0,0,−1) at yaw 0) — NOT the bot-facing atan2(dx,dz).
    const want = Math.atan2(-dx, -dz);
    const err = wrapPi(want - player.yaw);
    return [
      clamp(dist / 25, 0, 1), // dist
      clamp(cosB, -1, 1), // cosB
      clamp(sinB, -1, 1), // sinB
      clamp((target.pos.y - player.pos.y) / 8, -1, 1), // elev
      player.onGround ? 1 : 0, // grounded
      clamp(Math.hypot(player.vel.x, player.vel.z) / 20, 0, 1), // speed
      this.tgtSpeed, // enemySpeed
      clamp(Math.abs(err) / Math.PI, 0, 1), // aimErr
      clamp(this.recentDeath, 0, 1), // recentDeath
      clamp(railCd / RAIL_COOLDOWN, 0, 1), // fireCd (0 = ready)
      clamp(player.dashCooldown / DASH_COOLDOWN, 0, 1), // dashCd (0 = ready)
      clamp(player.boostCooldown / BOOST_COOLDOWN, 0, 1), // boostCd (0 = ready)
      1, // bias
    ];
  }
}

// Keep the FEATURE_COUNT contract explicit (compiler-time guard if it ever
// changes and this list drifts).
const PILOT_FEATURE_COUNT = 13;
if (RL_FEATURE_COUNT !== PILOT_FEATURE_COUNT) {
  throw new Error('PlayerPilot feature list out of sync with rl-brain.ts');
}