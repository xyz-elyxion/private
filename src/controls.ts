// Canonical control list — the SINGLE source of truth shared by the Landing
// page, the first-run onboarding primer, and the in-match Click-to-Play hint, so
// they can never drift apart. (They used to disagree: Landing omitted the
// right-click movement ability, and neither surface taught weapon cooldowns — the
// core combat rhythm a new player has to feel.)
export const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['WASD', 'Move'],
  ['Mouse', 'Aim'],
  ['Left click', 'Fire equipped weapon — cooldown varies by weapon'],
  ['Space', 'Jump (double-jump in the air)'],
  ['Q', 'Dash (directional, short cooldown)'],
  ['E', 'Zoom / aim (hold)'],
  ['L-Ctrl', 'Crouch (hold)'],
  ['L-Shift', 'Slide while crouching + moving'],
  ['Right click', 'Use your equipped ability (Teleport or Bodyguard)'],
  ['Wall + Space', 'Wall-jump for height + speed'],
  ['Tab', 'Scoreboard'],
  ['Esc', 'Release mouse / menu'],
];
