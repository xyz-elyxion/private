import type { AABB, Vec3 } from './types';
import type { ArenaMap } from './map';

export const COMMUNITY_MAP_VERSION = 1;

export type CommunityMapDocument = {
  version: 1;
  id: string;
  name: string;
  bounds: AABB;
  spawn: Vec3;
  boxes: AABB[];
};

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const vec = (v: unknown): v is Vec3 => {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return finite(p.x) && finite(p.y) && finite(p.z);
};
const box = (v: unknown): v is AABB => {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (!vec(b.min) || !vec(b.max)) return false;
  const min = b.min as Vec3;
  const max = b.max as Vec3;
  return min.x < max.x && min.y < max.y && min.z < max.z;
};

export function validateCommunityMap(value: unknown): value is CommunityMapDocument {
  if (!value || typeof value !== 'object') return false;
  const map = value as Record<string, unknown>;
  if (map.version !== COMMUNITY_MAP_VERSION || typeof map.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(map.id)) return false;
  if (typeof map.name !== 'string' || map.name.trim().length < 2 || map.name.length > 48) return false;
  if (!box(map.bounds) || !vec(map.spawn) || !Array.isArray(map.boxes) || map.boxes.length < 2 || map.boxes.length > 256) return false;
  const bounds = map.bounds as AABB;
  const spawn = map.spawn as Vec3;
  if (spawn.x < bounds.min.x || spawn.x > bounds.max.x || spawn.y < bounds.min.y || spawn.y > bounds.max.y || spawn.z < bounds.min.z || spawn.z > bounds.max.z) return false;
  return map.boxes.every((item) => box(item));
}

export function parseCommunityMap(json: string): CommunityMapDocument {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON');
  }
  if (!validateCommunityMap(value)) throw new Error('Invalid community map document');
  return value;
}

export function communityMapToArena(map: CommunityMapDocument): ArenaMap {
  if (!validateCommunityMap(map)) throw new Error('Invalid community map document');
  return {
    name: map.name,
    boxes: map.boxes,
    spawn: map.spawn,
    bounds: map.bounds,
    openTop: true,
  };
}

export function serializeCommunityMap(map: CommunityMapDocument): string {
  if (!validateCommunityMap(map)) throw new Error('Invalid community map document');
  return `${JSON.stringify(map, null, 2)}\n`;
}