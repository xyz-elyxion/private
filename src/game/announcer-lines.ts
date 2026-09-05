// ── Announcer pack line sets ─────────────────────────────────────────────────
//
// The single source of truth for what each announcer pack SAYS. Each event (a
// SoundClipName announcer clip) maps to an array of line VARIANTS, so the same
// event doesn't repeat the same line every time — the player hears variety, and
// each pack has its own personality.
//
// This module is shared by BOTH the client (audio.ts reads the variant counts to
// pick + preload `<clip>_<i>.mp3`) and the generator (scripts/gen-announcers.ts
// turns each line into that MP3). Keep the array ORDER stable: variant N maps to
// `<clip>_<N>.mp3`, so reordering/inserting mid-array re-points existing files.
//
// `legacy` is intentionally empty — it keeps the original single-file .ogg /
// procedural / TTS announcer. The meme pack uses fixed, hand-supplied files with
// the same names as their events.

import type { AnnouncerPackId, SoundClipName } from './audio';

type AnnouncerLineSet = Partial<Record<SoundClipName, string[]>>;

export const ANNOUNCER_PACK_LINES: Record<AnnouncerPackId, AnnouncerLineSet> = {
  legacy: {},
  memes: {
    // The files in public/sounds/elyxion/announcer/memes are single clips rather
    // than numbered generated variants. Their presence is handled by audio.ts.
  },
};

// Variant line texts for a pack's clip (empty = pack doesn't voice this event →
// audio.ts falls back to the legacy file / procedural / TTS).
export function announcerVariants(pack: AnnouncerPackId, clip: SoundClipName): string[] {
  return ANNOUNCER_PACK_LINES[pack]?.[clip] ?? [];
}

// How many generated `<clip>_<i>.mp3` files this pack has for the event (0 = none).
// The fixed-file meme pack is counted separately by SoundManager.
export function announcerVariantCount(pack: AnnouncerPackId, clip: SoundClipName): number {
  return announcerVariants(pack, clip).length;
}
