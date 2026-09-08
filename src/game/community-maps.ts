import type { CommunityMapDocument } from './community-map';

export const COMMUNITY_CITADEL: CommunityMapDocument = {
  version: 1,
  id: 'community-citadel',
  name: 'Citadel',
  bounds: { min: { x: -28, y: -1, z: -20 }, max: { x: 28, y: 18, z: 20 } },
  spawn: { x: 0, y: 0.05, z: 16 },
  boxes: [
    { min: { x: -28, y: -1, z: -20 }, max: { x: 28, y: 0, z: 20 } },
    { min: { x: -28, y: 17, z: -20 }, max: { x: 28, y: 18, z: 20 } },
    { min: { x: -28, y: 0, z: -20 }, max: { x: -27, y: 17, z: 20 } },
    { min: { x: 27, y: 0, z: -20 }, max: { x: 28, y: 17, z: 20 } },
    { min: { x: -28, y: 0, z: -20 }, max: { x: 28, y: 17, z: -19 } },
    { min: { x: -28, y: 0, z: 19 }, max: { x: 28, y: 17, z: 20 } },
    { min: { x: -4, y: 0, z: -10 }, max: { x: 4, y: 5, z: -7 } },
    { min: { x: -4, y: 0, z: 7 }, max: { x: 4, y: 5, z: 10 } },
    { min: { x: -18, y: 0, z: -2 }, max: { x: -12, y: 3, z: 2 } },
    { min: { x: 12, y: 0, z: -2 }, max: { x: 18, y: 3, z: 2 } },
    { min: { x: -2, y: 5, z: -2 }, max: { x: 2, y: 5.6, z: 2 } },
  ],
};