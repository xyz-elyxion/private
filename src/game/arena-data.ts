// Pure (THREE-free) arena network data — the single source of truth the GAME
// SERVER uses for spawns, out-of-bounds checks, and authoritative shot occlusion.
// It must stay importable from `server/*` (Node, no DOM), so this file MUST NOT
// import three.js, `map.ts`, `textures.ts`, or anything that touches document/window.

import type { AABB, Vec3 } from './types';

export type ArenaNetData = {
  bounds: AABB;
  killY: number;
  spawns: Vec3[];
  // Collision-only cover/walls used by the server's hitscan line-of-sight test.
  // Floors are intentionally omitted; shots between players should only be
  // blocked by solid vertical/raised cover and the arena perimeter.
  occluders: AABB[];
};

const Y = 0.05;
const p = (x: number, z: number): Vec3 => ({ x, y: Y, z });
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): AABB => ({
  min: { x: x0, y: y0, z: z0 },
  max: { x: x1, y: y1, z: z1 },
});

function arena(bounds: AABB, spawns: Vec3[], occluders: AABB[]): ArenaNetData {
  return { bounds, killY: bounds.min.y - 6, spawns, occluders };
}

const CAUSEWAY_OCCLUDERS = [
  box(-35, 0, -25, -33, 21, 25), box(33, 0, -25, 35, 21, 25),
  box(-35, 0, -25, 35, 21, -23), box(-35, 0, 23, 35, 21, 25),
  box(-28, 4, -18, -18, 4.6, -9), box(18, 4, -18, 28, 4.6, -9),
  box(-28, 4, 9, -18, 4.6, 18), box(18, 4, 9, 28, 4.6, 18),
  box(-7, 8, -6, 7, 8.6, 6),
  box(-3, 0, -16, -1, 12, -14), box(1, 0, 14, 3, 12, 16),
  box(-15, 0, -1, -13, 12, 1), box(13, 0, -1, 15, 12, 1),
  box(-32, 0, -16, -28, 1.3, -12), box(-32, 1.3, -16, -30, 2.6, -12), box(-30, 2.6, -16, -28, 4, -12),
  box(28, 0, 12, 32, 1.3, 16), box(30, 1.3, 12, 32, 2.6, 16), box(28, 2.6, 12, 30, 4, 16),
  box(-6, 0, -20, -2, 1.2, -17), box(2, 0, 17, 6, 1.2, 20),
];

const REACTOR_OCCLUDERS = [
  box(-40, 0, -28, -38, 23, 28), box(38, 0, -28, 40, 23, 28),
  box(-40, 0, -28, 40, 23, -26), box(-40, 0, 26, 40, 23, 28),
  box(-14, 0, -26, -12, 14, -8), box(-14, 0, 8, -12, 14, 26),
  box(12, 0, -26, 14, 14, -8), box(12, 0, 8, 14, 14, 26),
  box(-3, 0, -3, 3, 14, 3), box(3, 5, -3, 10, 5.6, 1), box(-10, 9.5, -1, -3, 10.1, 3),
  box(-4, 14, -4, 4, 14.6, 4),
  box(-34, 3.5, -8, -22, 4.1, 8), box(22, 3.5, -8, 34, 4.1, 8),
  box(-30, 0, -20, -28, 7, -18), box(-30, 0, 18, -28, 7, 20),
  box(28, 0, -20, 30, 7, -18), box(28, 0, 18, 30, 7, 20),
  box(-22, 0, -2, -20, 1.2, 2), box(-24, 1.2, -2, -22, 2.4, 2), box(-26, 2.4, -2, -24, 3.5, 2),
  box(20, 0, -2, 22, 1.2, 2), box(22, 1.2, -2, 24, 2.4, 2), box(24, 2.4, -2, 26, 3.5, 2),
  box(-34, 0, -22, -30, 1.2, -19), box(30, 0, 19, 34, 1.2, 22),
];

const LOUNGE_OCCLUDERS = [
  box(-30, 0, -22, -28, 19, 22), box(28, 0, -22, 30, 19, 22),
  box(-30, 0, -22, 30, 19, -20), box(-30, 0, 20, 30, 19, 22),
  box(-26, 0, -10, -16, 3, -7), box(-26, 0, -7, -23, 3, 2),
  box(16, 0, 7, 26, 3, 10), box(23, 0, -2, 26, 3, 7),
  box(-10, 0, -18, -7, 5, -12), box(7, 0, 12, 10, 5, 18),
  box(-4, 0, 12, -1, 5, 18), box(1, 0, -18, 4, 5, -12),
  box(-28, 5, -22, -24, 5.6, 22), box(24, 5, -22, 28, 5.6, 22),
  box(-6, 0, -4, 6, 1.2, 4), box(-2, 9.5, -2, 2, 10.1, 2), box(-1, 1.2, 5, 1, 8, 7),
  box(-16, 0, 6, -12, 1.1, 10), box(12, 0, -10, 16, 1.1, -6),
];

const CONTAINERYARD_OCCLUDERS = [
  box(-13, 0, -11, -12, 12, 11), box(12, 0, -11, 13, 12, 11),
  box(-13, 0, -11, 13, 12, -10), box(-13, 0, 10, 13, 12, 11),
  box(-3, 0, -2.5, 3, 2.6, 2.5), box(-2, 2.6, -1.5, 2, 3, 1.5), box(-1.5, 8, -1.5, 1.5, 8.5, 1.5),
  box(4, 0, -8, 8, 2.6, -5), box(2.5, 0, -8, 4, 1.5, -6),
  box(-8, 0, 5, -4, 2.6, 8), box(-4, 0, 6, -2.5, 1.5, 8),
  box(-8, 0, -8, -4, 1.2, -5), box(4, 0, 5, 8, 1.2, 8),
  box(-10, 0, -1, -8, 4, 1), box(8, 0, -1, 10, 4, 1),
  box(-11, 0, 4, -9, 1.2, 7), box(9, 0, -7, 11, 1.2, -4),
];

const DERRICK_OCCLUDERS = [
  box(-12, 0, -12, -11, 22, 12), box(11, 0, -12, 12, 22, 12),
  box(-12, 0, -12, 12, 22, -11), box(-12, 0, 11, 12, 22, 12),
  box(-2, 0, -2, 2, 11, 2), box(-3, 11, -3, 3, 11.5, 3),
  box(2, 5, -2, 7, 5.5, 2), box(-7, 5, -2, -2, 5.5, 2),
  box(-2, 8, 2, 2, 8.5, 7), box(-2, 8, -7, 2, 8.5, -2),
  box(-10, 0, 5, -6, 2, 9), box(6, 0, -9, 10, 2, -5),
  box(-9, 0, -7, -7, 6, -5), box(7, 0, 5, 9, 6, 7),
  box(-6, 0, -2, -3, 1.2, 2), box(3, 0, -2, 6, 1.2, 2),
];

const NUKETOWN_OCCLUDERS = [
  box(-32, 0, -22, -31, 16, 22), box(31, 0, -22, 32, 16, 22),
  box(-32, 0, 21, 32, 16, 22), box(-32, 0, -22, 32, 16, -21),
  box(-27, 0, -9, -26, 7, 9), box(-27, 0, 8, -20, 7, 9), box(-27, 0, -9, -20, 7, -8),
  box(-26, 3.6, -9, -19, 4, 9), box(-21, 0, -8, -19, 1.3, -5), box(-24, 1.3, -8, -21, 2.6, -5), box(-26, 2.6, -8, -24, 4, -5),
  box(-18, 0, -3, -17, 1.3, 3), box(-27, 6.5, -9, -19, 7, 9),
  box(26, 0, -9, 27, 7, 9), box(20, 0, 8, 27, 7, 9), box(20, 0, -9, 27, 7, -8),
  box(19, 3.6, -9, 26, 4, 9), box(19, 0, -8, 21, 1.3, -5), box(21, 1.3, -8, 24, 2.6, -5), box(24, 2.6, -8, 26, 4, -5),
  box(17, 0, -3, 18, 1.3, 3), box(19, 6.5, -9, 27, 7, 9),
  box(-6, 0, 9, 8, 2.9, 12), box(-8, 0, -12, 2, 2.6, -9),
  box(3, 0, -6, 8, 1.4, -3), box(-8, 0, 3, -3, 1.4, 6), box(-2, 0, -2, 2, 1.2, 2),
  box(-2, 0, 15, 3, 1.3, 18), box(-3, 0, -18, 2, 1.3, -15),
];

export const ARENA_NET: Record<string, ArenaNetData> = {
  causeway: arena(
    { min: { x: -35, y: -1, z: -25 }, max: { x: 35, y: 22, z: 25 } },
    [p(0, 19), p(0, -19), p(-28, 0), p(28, 0), p(-12, 12), p(12, -12)],
    CAUSEWAY_OCCLUDERS,
  ),
  reactor: arena(
    { min: { x: -40, y: -1, z: -28 }, max: { x: 40, y: 24, z: 28 } },
    [p(-30, 0), p(30, 0), p(0, 12), p(0, -12), p(-30, 12), p(30, -12)],
    REACTOR_OCCLUDERS,
  ),
  lounge: arena(
    { min: { x: -30, y: -1, z: -22 }, max: { x: 30, y: 20, z: 22 } },
    [p(0, 16), p(0, -16), p(-20, 0), p(20, 0), p(-12, 12), p(12, -12)],
    LOUNGE_OCCLUDERS,
  ),
  nuketown: arena(
    { min: { x: -32, y: -1, z: -22 }, max: { x: 32, y: 17, z: 22 } },
    [p(-29, 0), p(-29, 11), p(-29, -11), p(29, 0), p(29, 11), p(29, -11), p(-12, 16), p(12, 16), p(-12, -16), p(12, -16)],
    NUKETOWN_OCCLUDERS,
  ),
  containeryard: arena(
    { min: { x: -13, y: -1, z: -11 }, max: { x: 13, y: 13, z: 11 } },
    [p(-10.5, 8.5), p(10.5, -8.5), p(-10.5, -8.5), p(10.5, 8.5), p(0, 9), p(0, -9)],
    CONTAINERYARD_OCCLUDERS,
  ),
  derrick: arena(
    { min: { x: -12, y: -1, z: -12 }, max: { x: 12, y: 23, z: 12 } },
    [p(9, 9), p(-9, -9), p(0, 9), p(0, -9), p(-9, 0), p(9, 0)],
    DERRICK_OCCLUDERS,
  ),
  training: arena(
    { min: { x: -23, y: -1, z: -20 }, max: { x: 23, y: 25, z: 20 } },
    [p(0, 17), p(-18, -10), p(18, -10), p(-18, 10), p(18, 10), p(0, 0)],
    [],
  ),
};

export const DEFAULT_ARENA_ID = 'causeway';

export function arenaNet(id: string): ArenaNetData {
  return ARENA_NET[id] ?? ARENA_NET[DEFAULT_ARENA_ID];
}

const FFA_MAP_POOL = ['causeway', 'reactor', 'lounge', 'nuketown'] as const;
const DUEL_MAP_POOL = ['containeryard', 'derrick'] as const;
export const ONLINE_MAP_POOL = [...FFA_MAP_POOL, ...DUEL_MAP_POOL] as const;

export function mapPoolForMode(mode: string): readonly string[] {
  return mode === 'duel' ? DUEL_MAP_POOL : FFA_MAP_POOL;
}

export const MAP_VOTE_DURATION_SEC = 15;
export const MAP_VOTE_OPTIONS = 3;
export const POTG_GUARD_SEC = 14;
export const POST_MATCH_RESET_SEC = 4;
export const ROOM_CODE_LEN = 5;

export function isOutOfBounds(pos: Vec3, a: ArenaNetData): boolean {
  if (pos.y < a.killY) return true;
  const m = 2;
  return pos.x < a.bounds.min.x - m || pos.x > a.bounds.max.x + m || pos.z < a.bounds.min.z - m || pos.z > a.bounds.max.z + m;
}
