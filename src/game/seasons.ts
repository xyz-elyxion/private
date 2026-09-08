export type SeasonReward = {
  tier: number;
  cosmeticId: string;
  name: string;
};

export type SeasonInfo = {
  id: string;
  name: string;
  startsAt: number;
  endsAt: number;
  xpPerTier: number;
  rewards: readonly SeasonReward[];
};

const SEASON_LENGTH_MS = 12 * 7 * 86_400_000;
const FIRST_SEASON_START = Date.UTC(2026, 8, 1);
const SEASON_REWARD_SETS: readonly (readonly SeasonReward[])[] = [[
  { tier: 1, cosmeticId: 'rail.plasma', name: 'Plasma Rail' },
  { tier: 2, cosmeticId: 'spawn.ring', name: 'Shockwave Spawn' },
  { tier: 3, cosmeticId: 'hat.graduation', name: 'Graduate Hat' },
  { tier: 4, cosmeticId: 'card.cyber', name: 'Cyber Card' },
  { tier: 5, cosmeticId: 'unusual.embers', name: 'Searing Embers' },
  { tier: 6, cosmeticId: 'rail.ember', name: 'Ember Rail' },
  { tier: 7, cosmeticId: 'hat.propeller', name: 'Propeller Cap' },
  { tier: 8, cosmeticId: 'card.gold', name: 'Gilded Card' },
  { tier: 9, cosmeticId: 'unusual.halo', name: 'Radiant Halo' },
  { tier: 10, cosmeticId: 'title.centurion', name: 'Centurion Title' },
], [
  { tier: 1, cosmeticId: 'rail.toxic', name: 'Toxic Rail' },
  { tier: 2, cosmeticId: 'spawn.ember', name: 'Cinder Spawn' },
  { tier: 3, cosmeticId: 'hat.baseball', name: 'Ballcap Pro' },
  { tier: 4, cosmeticId: 'card.ember', name: 'Ember Card' },
  { tier: 5, cosmeticId: 'unusual.storm', name: 'Storm Cloud' },
  { tier: 6, cosmeticId: 'rail.gold', name: 'Gold Rail' },
  { tier: 7, cosmeticId: 'hat.tophat', name: 'Top Hat' },
  { tier: 8, cosmeticId: 'card.nebula', name: 'Nebula Card' },
  { tier: 9, cosmeticId: 'unusual.orbit', name: 'Orbiting Energy' },
  { tier: 10, cosmeticId: 'title.champion', name: 'Champion Title' },
]];

export function seasonFor(now: number = Date.now()): SeasonInfo {
  const index = Math.max(0, Math.floor((now - FIRST_SEASON_START) / SEASON_LENGTH_MS));
  const startsAt = FIRST_SEASON_START + index * SEASON_LENGTH_MS;
  return {
    id: `s${index + 1}`,
    name: `Season ${index + 1}`,
    startsAt,
    endsAt: startsAt + SEASON_LENGTH_MS,
    xpPerTier: 1_000,
    rewards: SEASON_REWARD_SETS[index % SEASON_REWARD_SETS.length],
  };
}

export function seasonTier(xp: number, season: SeasonInfo = seasonFor()): number {
  return Math.min(season.rewards.length, Math.max(0, Math.floor(xp / season.xpPerTier)));
}

export function seasonXpForMatch(kills: number, won: boolean): number {
  return Math.min(250, 50 + Math.max(0, Math.min(25, Math.floor(kills))) * 8 + (won ? 50 : 0));
}