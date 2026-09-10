/* ─────────────────────────────────────────────────────────────────────────────
 * CrazyGames SDK v3 integration — the ONLY file that talks to the CrazyGames SDK.
 *
 * Everything here follows the current official SDK v3 documentation:
 *   https://docs.crazygames.com/sdk/intro/   (init, environments, promises)
 *   https://docs.crazygames.com/sdk/game/    (gameplayStart/Stop, loading, rooms, invites)
 *   https://docs.crazygames.com/sdk/video-ads/ (midgame/rewarded, adblock, cooldowns)
 *   https://docs.crazygames.com/sdk/user/    (getUser, showAuthPrompt, tokens, listeners)
 *   https://docs.crazygames.com/sdk/data/    (localStorage-shaped save module)
 *
 * Design rules:
 *  - The SDK <script> is loaded in index.html BEFORE the game bundle. If it
 *    fails to load or init (local dev, adblock, offline, sitelock-disabled env,
 *    crazygames.com/preview), every call here degrades to a safe no-op — the
 *    game stays fully playable outside CrazyGames. Nothing throws outward.
 *  - Core game logic never imports `window.CrazyGames` directly; it imports
 *    these functions. There is exactly one init (`initCrazyGames`) and one
 *    subscription point per feature.
 *  - Environment model (v3): `crazygames` (on-site), `local` (localhost /
 *    preview), `disabled` (any other domain → SDK calls would throw, so we
 *    short-circuit and use localStorage/fallbacks there).
 * ────────────────────────────────────────────────────────────────────────── */

type CgSdk = {
  init: () => Promise<void>;
  environment: 'crazygames' | 'local' | 'disabled';
  ad: {
    requestAd(type: 'midgame' | 'rewarded', callbacks?: {
      adFinished?: () => void;
      adError?: (error: { code?: string; message?: string }) => void;
      adStarted?: () => void;
    }): void;
    hasAdblock: () => Promise<boolean>;
  };
  banner: {
    requestResponsiveBanner: (id: string) => Promise<void>;
    clearBanner: (id: string) => void;
    clearAllBanners: () => void;
  };
  game: {
    loadingStart: () => void;
    loadingStop: () => void;
    gameplayStart: () => void;
    gameplayStop: () => void;
    happytime: () => void;
    reportGameCompletedPercentage: (progress: number) => void;
    settings: { disableChat: boolean; muteAudio: boolean };
    addSettingsChangeListener: (l: (s: { disableChat: boolean; muteAudio: boolean }) => void) => void;
    removeSettingsChangeListener: (l: (s: { disableChat: boolean; muteAudio: boolean }) => void) => void;
    isInstantMultiplayer: boolean;
    updateRoom: (room: { roomId?: string; isJoinable?: boolean; inviteParams?: Record<string, string> }) => void;
    leftRoom: () => void;
    inviteLink: (params: Record<string, string>) => Promise<string>;
    getInviteParam: (key: string) => string | null;
    inviteParams: Record<string, string> | null;
    addJoinRoomListener: (l: (params: Record<string, string>) => void) => void;
    removeJoinRoomListener: (l: (params: Record<string, string>) => void) => void;
  };
  user: {
    isUserAccountAvailable: boolean;
    getUser: () => Promise<{ username: string; profilePictureUrl?: string } | null>;
    showAuthPrompt: () => Promise<{ username: string; profilePictureUrl?: string } | null>;
    getUserToken: () => Promise<string>;
    submitScore: (s: { encryptedScore: string; score: number }) => void;
    addAuthListener: (l: (user: { username: string; profilePictureUrl?: string } | null) => void) => void;
    removeAuthListener: (l: (user: { username: string; profilePictureUrl?: string } | null) => void) => void;
  };
  data: {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
    removeItem: (k: string) => void;
  };
};

type CgWindow = Window & { CrazyGames?: { SDK?: CgSdk } };

export type CgEnvironment = 'crazygames' | 'local' | 'disabled';
export type CgUser = { username: string; profilePictureUrl?: string };
export type CgGameSettings = { disableChat: boolean; muteAudio: boolean };

type CgError = { code?: string; message?: string };

const win = typeof window !== 'undefined' ? (window as CgWindow) : undefined;

// Does the SDK <script> tag from index.html actually exist in the page?
// The script is unconditionally included (see index.html); QA and platform
// detection look for it literally. Append ?cgdev=1 on localhost to opt into
// the SDK's simulated "local" environment (demo ads + login) for testing.
function sdkScriptPresent(): boolean {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector<HTMLScriptElement>(
    'script[src*="sdk.crazygames.com"], script[src*="crazygames-sdk"]',
  );
}

let sdk: CgSdk | null = null;
let initPromise: Promise<void> | null = null;
let environment: CgEnvironment = 'disabled';

/* ───────────────────────── Init & environment ───────────────────────── */

/**
 * Load/init the SDK exactly once. Safe to call from anywhere, any number of
 * times — every caller awaits the same promise. Resolves even on failure so
 * the game boots regardless; check `cgReady()` / `cgEnvironment()` afterwards.
 */
export function initCrazyGames(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const candidate = (win?.CrazyGames as { SDK?: CgSdk } | undefined)?.SDK;
      if (!candidate || typeof candidate.init !== 'function') {
        // No SDK on the page (local dev, script blocked, old cache): run in
        // fallback mode. The game is 100% playable like this.
        sdk = null;
        environment = 'disabled';
        return;
      }
      sdk = candidate;
      // v3 requires an awaited init before ANY other SDK call. The init also
      // preloads the data module's save data, so doing it first matters.
      await candidate.init();
      environment = candidate.environment ?? 'disabled';
      // `local` = running on localhost. The SDK simulates ads/login there for
      // integration testing — but ONLY when the developer explicitly opts in
      // via ?cgdev=1 (see index.html). Plain local dev resolves to 'disabled'
      // so demos/fake users never leak into normal development.
      if (environment === 'local') {
        const devSim = /[?&]cgdev=1/.test(window.location.search);
        environment = devSim ? 'local' : 'disabled';
      }
      // `disabled` means "hosted outside CrazyGames" (own domain, itch, etc):
      // every SDK call would throw there, so treat it exactly like absent —
      // the game plays identically with no platform, no ads, no login UI.
      if (environment === 'disabled') sdk = null;
    } catch {
      // Init can fail under sitelock/network issues; keep the game running.
      sdk = null;
      environment = 'disabled';
    }
  })();
  return initPromise;
}

/** True once initCrazyGames() finished AND the SDK is actually usable. */
export function cgReady(): boolean {
  return sdk !== null;
}

/** Current platform environment: 'crazygames' | 'local' | 'disabled'. */
export function cgEnvironment(): CgEnvironment {
  return environment;
}

/** True only when running on CrazyGames (or the local dev sim). */
export function isOnCrazyGames(): boolean {
  return sdk !== null && (environment === 'crazygames' || environment === 'local');
}

/** SDK script tag is in the page (even if init failed — useful for QA gates). */
export function cgSdkScriptPresent(): boolean {
  return sdkScriptPresent();
}

/** Private internal helper (also used by the QA panel). */
export function cgSdk(): CgSdk | null {
  return sdk;
}

/* ───────────────────────── Game settings (muteAudio / disableChat) ───── */

let cgSettings: CgGameSettings = { disableChat: false, muteAudio: false };
const settingsListeners = new Set<(s: CgGameSettings) => void>();

function pushSettings(s: CgGameSettings, force = false) {
  const next = { disableChat: !!s.disableChat, muteAudio: !!s.muteAudio };
  const changed = force || next.disableChat !== cgSettings.disableChat || next.muteAudio !== cgSettings.muteAudio;
  cgSettings = next;
  if (changed) for (const l of settingsListeners) l(next);
}

/**
 * Live CrazyGames game settings. `muteAudio` must take priority over the
 * in-game audio toggle (per the docs), so audio consumers should fold this in
 * as: `effectiveMuted = userMuted || settings.muteAudio`.
 */
export function cgGameSettings(): CgGameSettings {
  return cgSettings;
}

export function onCgGameSettings(l: (s: CgGameSettings) => void): () => void {
  settingsListeners.add(l);
  // Subscribe to the SDK while someone cares. If init hasn't resolved yet the
  // attach happens on init completion (below) — never dropped by a slow SDK.
  if (settingsListeners.size === 1 && sdk) {
    try {
      sdk.game.addSettingsChangeListener(pushSettings);
    } catch { /* ignore */ }
  }
  void initCrazyGames().then(() => {
    if (settingsListeners.size > 0 && sdk) {
      try {
        sdk.game.addSettingsChangeListener(pushSettings);
      } catch { /* ignore */ }
    }
  });
  return () => {
    settingsListeners.delete(l);
    if (settingsListeners.size === 0 && sdk) {
      try {
        sdk.game.removeSettingsChangeListener(pushSettings);
      } catch { /* ignore */ }
    }
  };
}

/** Read the current platform settings once (called right after init). */
export function syncCgSettings(): void {
  try {
    // The SDK resolves ?disableChat=true / ?muteAudio=true itself on CrazyGames;
    // honoring the same params locally lets us QA the chat/audio behavior on our
    // own site too. force=true so an explicit ?param always wins over defaults.
    const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const forced: CgGameSettings = {
      disableChat: q?.get('disableChat') === 'true' || sdk?.game?.settings?.disableChat === true,
      muteAudio: q?.get('muteAudio') === 'true' || sdk?.game?.settings?.muteAudio === true,
    };
    pushSettings(forced, true);
  } catch { /* ignore */ }
}

/* ───────────────────────── Loading & gameplay events ─────────────────── */

/**
 * SDK loadingStart — call when the game begins loading anything meaningful
 * (client boot, map chunk, etc). No-op when the SDK is unavailable.
 */
export function cgLoadingStart(): void {
  try {
    sdk?.game.loadingStart();
  } catch { /* ignore */ }
}

/** SDK loadingStop — call when loading completes and gameplay is about to start. */
export function cgLoadingStop(): void {
  try {
    sdk?.game.loadingStop();
  } catch { /* ignore */ }
}

/**
 * GameplayStart — REQUIRED event. Call on every entry into real gameplay:
 * match start, resume after pause/menu/ad, revive, next level.
 */
export function cgGameplayStart(): void {
  try {
    sdk?.game.gameplayStart();
  } catch { /* ignore */ }
}

/**
 * GameplayStop — call on every break: entering a menu, pausing, match end,
 * disconnect overlay. The docs explicitly say NOT to call it when the player
 * merely switches browser focus or leaves the game area (platform handles that).
 */
export function cgGameplayStop(): void {
  try {
    sdk?.game.gameplayStop();
  } catch { /* ignore */ }
}

/** happytime() — platform celebration for special moments. Use sparingly. */
export function cgHappytime(): void {
  try {
    sdk?.game.happytime();
  } catch { /* ignore */ }
}

/**
 * reportGameCompletedPercentage — tell CrazyGames how far the player has gotten
 * in the game (0-100). HTML5 only. Intermediate updates are encouraged; 100
 * marks real completion. No-op when the SDK is unavailable / older SDK build.
 */
export function cgReportGameCompleted(percent: number): void {
  try {
    if (!sdk) return;
    const pct = Math.round(percent);
    if (!Number.isFinite(pct)) return;
    sdk.game.reportGameCompletedPercentage?.(Math.max(0, Math.min(100, pct)));
  } catch { /* ignore */ }
}

// Per docs: client-side leaderboard scores must be AES-GCM encrypted with the
// developer-portal Encryption Key; both encrypted + plain values are submitted.
async function encryptScore(score: number, encryptionKey: string): Promise<string | null> {
  try {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const algorithm = { name: 'AES-GCM', iv };
    const keyBytes = new Uint8Array(
      atob(encryptionKey)
        .split('')
        .map((c) => c.charCodeAt(0)),
    );
    const cryptoKey = await window.crypto.subtle.importKey('raw', keyBytes, algorithm, false, ['encrypt']);
    const dataBuffer = new TextEncoder().encode(score.toString());
    const encryptedBuffer = await window.crypto.subtle.encrypt(algorithm, cryptoKey, dataBuffer);
    const combined = new Uint8Array(iv.length + encryptedBuffer.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encryptedBuffer), iv.length);
    let binary = '';
    for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
    return btoa(binary);
  } catch {
    return null;
  }
}

/**
 * Submit a score to the game's CrazyGames leaderboard (client-side path per
 * docs). Resolves false when the encryption key isn't configured (build-time
 * VITE_CG_LEADERBOARD_KEY), crypto/HTTPS is missing, or the SDK is unavailable
 * — the game never blocks or retries on failure; the platform rejects
 * duplicate/rate-limited submissions server-side itself.
 */
export async function cgSubmitScore(score: number): Promise<boolean> {
  try {
    if (!sdk || !Number.isFinite(score)) return false;
    const key = (import.meta.env.VITE_CG_LEADERBOARD_KEY as string | undefined)?.trim();
    if (!key) return false;
    const encrypted = await encryptScore(score, key);
    if (!encrypted || typeof sdk.user.submitScore !== 'function') return false;
    sdk.user.submitScore({ encryptedScore: encrypted, score });
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────────── Video ads ─────────────────────────────────── */

// SDK-enforced midgame cooldown is ~3 minutes; keep our own guard so a
// double-fire bug (or an overeager retry) can never send two requests.
const AD_COOLDOWN_MS = 120_000;
let lastAdAt = 0;
let adInFlight = false;

export type AdResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'cooldown' | 'busy' | 'error'; code?: string };

/**
 * Request a midgame ad. Pauses gameplay + mutes audio via the callbacks, and
 * guarantees exactly one of `onDone`/`onError` fires even if the SDK hangs
 * (defensive timeout). Never throws.
 */
export async function cgRequestMidgameAd(handlers: {
  onAdStart?: () => void;
  onAdEnd?: (err?: CgError) => void;
}): Promise<AdResult> {
  const now = Date.now();
  if (adInFlight) return { ok: false, reason: 'busy' };
  if (now - lastAdAt < AD_COOLDOWN_MS) return { ok: false, reason: 'cooldown' };
  if (!sdk) return { ok: false, reason: 'unavailable' };

  adInFlight = true;
  lastAdAt = now;
  let settled = false;
  // Safety net: if neither adFinished nor adError ever fires (SDK bug), recover
  // the game after 65s — ads are typically 15-30s; the docs warn the game must
  // not stay paused forever if the ad pipeline stalls.
  const watchdog = setTimeout(() => finish(undefined, true), 65_000);

  const finish = (err?: CgError, timedOut = false) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    adInFlight = false;
    try {
      handlers.onAdEnd?.(err);
    } catch { /* ignore */ }
    if (timedOut) console.warn('[crazygames] ad neither finished nor errored within 65s — resuming game');
  };

  return new Promise<AdResult>((resolve) => {
    try {
      sdk!.ad.requestAd('midgame', {
        adStarted: () => handlers.onAdStart?.(),
        adFinished: () => finish(),
        adError: (error) => finish(error),
      });
      resolve({ ok: true });
    } catch (e) {
      // Adblock / unfilled / SDK throw: the game must keep working.
      finish(e as CgError);
      resolve({ ok: false, reason: 'error', code: (e as CgError)?.code });
    }
  });
}

/** Whether a midgame ad is currently being requested/played. */
export function cgAdInFlight(): boolean {
  return adInFlight;
}

/** Adblock detection (v3 async API). Returns false when the SDK is unavailable. */
export async function cgHasAdblock(): Promise<boolean> {
  try {
    if (!sdk) return false;
    return await sdk.ad.hasAdblock();
  } catch {
    return false;
  }
}

/* ───────────────────────── Banners (responsive, static sizes) ────────── */

/**
 * Request a responsive banner into a container id. The container must be
 * non-zero sized and fully on-page. Errors (unfilled/cooldown/hidden) are
 * swallowed — banners are decorative revenue, never gameplay.
 */
export async function cgRequestBanner(id: string): Promise<boolean> {
  try {
    if (!sdk) return false;
    await sdk.banner.requestResponsiveBanner(id);
    return true;
  } catch {
    return false;
  }
}

export function cgClearAllBanners(): void {
  try {
    sdk?.banner.clearAllBanners();
  } catch { /* ignore */ }
}

/* ───────────────────────── User account ──────────────────────────────── */

/**
 * The logged-in CrazyGames user, or null when signed out / unavailable.
 * `isUserAccountAvailable` is a plain property in v3 (not a method).
 */
export async function cgGetUser(): Promise<CgUser | null> {
  try {
    if (!sdk || !sdk.user.isUserAccountAvailable) return null;
    return await sdk.user.getUser();
  } catch {
    return null;
  }
}

/**
 * Open CrazyGames' own login/register popup. Returns the user on success and
 * null if the player cancelled, is already signed in, or the prompt failed.
 */
export async function cgShowAuthPrompt(): Promise<CgUser | null> {
  try {
    if (!sdk || !sdk.user.isUserAccountAvailable) return null;
    return await sdk.user.showAuthPrompt();
  } catch {
    return null;
  }
}

/**
 * JWT user token (userId/username inside). 1h lifetime — always fetch fresh.
 * Server verifies it against https://sdk.crazygames.com/publicKey.json before
 * trusting it for account linking.
 */
export async function cgGetUserToken(): Promise<string | null> {
  try {
    if (!sdk || !sdk.user.isUserAccountAvailable) return null;
    return await sdk.user.getUserToken();
  } catch {
    return null;
  }
}

type CgListener = (user: CgUser | null) => void;
const authListeners = new Set<CgListener>();
let sdkAuthListener: CgListener | null = null;

function dispatchAuth(user: CgUser | null) {
  for (const l of authListeners) l(user);
}

/** Fired when the player logs in on CrazyGames mid-session. */
export function onCgAuth(l: CgListener): () => void {
  authListeners.add(l);
  const attach = () => {
    if (sdkAuthListener || !sdk) return;
    sdkAuthListener = (user) => dispatchAuth(user);
    try {
      sdk.user.addAuthListener(sdkAuthListener);
    } catch { /* ignore */ }
  };
  attach();
  void initCrazyGames().then(attach); // cover the not-yet-inited subscribe race
  return () => {
    authListeners.delete(l);
    if (authListeners.size === 0 && sdk && sdkAuthListener) {
      try {
        sdk.user.removeAuthListener(sdkAuthListener);
      } catch { /* ignore */ }
      sdkAuthListener = null;
    }
  };
}

/* ───────────────────────── Data module (save bridge) ─────────────────── */

/**
 * localStorage-compatible storage that routes through the CrazyGames data
 * module when available (synced to the player's CrazyGames account across
 * devices) and falls back to plain localStorage everywhere else. Per the docs,
 * the data module itself already mirrors to localStorage for guests and
 * transfers guest data on login — so no extra migration logic is needed here.
 */
export const cgStorage: {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
} = {
  getItem(k) {
    try {
      if (sdk?.data) return sdk.data.getItem(k);
    } catch { /* fall through to localStorage */ }
    try {
      return typeof window !== 'undefined' ? window.localStorage.getItem(k) : null;
    } catch {
      return null;
    }
  },
  setItem(k, v) {
    try {
      if (sdk?.data) {
        sdk.data.setItem(k, v); // may throw dataLimitExceeded — caught below
        return;
      }
    } catch {
      // 1MB limit / module disabled: fall back so progress is never lost.
    }
    try {
      window.localStorage.setItem(k, v);
    } catch { /* ignore */ }
  },
  removeItem(k) {
    try {
      if (sdk?.data) {
        sdk.data.removeItem(k);
        return;
      }
    } catch { /* ignore */ }
    try {
      window.localStorage.removeItem(k);
    } catch { /* ignore */ }
  },
};

/* ───────────────────────── Multiplayer rooms & invites ───────────────── */

/**
 * Report the room the player is currently in (or waiting in). `roomId` should
 * be unique per region+room; CrazyGames uses it for the invite button, platform
 * notifications and friends list.
 */
export function cgUpdateRoom(room: {
  roomId?: string;
  isJoinable?: boolean;
  inviteParams?: Record<string, string>;
}): void {
  try {
    sdk?.game.updateRoom(room);
  } catch { /* ignore */ }
}

/** Report that the player left their room (back to menu). */
export function cgLeftRoom(): void {
  try {
    sdk?.game.leftRoom();
  } catch { /* ignore */ }
}

/**
 * `isInstantMultiplayer` — when true, the platform asked us to drop the player
 * straight into a joinable multiplayer location (e.g. they clicked "play with
 * friends" on the game page). Zero-configuration, always present in v3.
 */
export function cgIsInstantMultiplayer(): boolean {
  try {
    return !!sdk?.game.isInstantMultiplayer;
  } catch {
    return false;
  }
}

/**
 * inviteParams present at page load — the game was opened from an invite link
 * (the SDK already parsed the query params). Null when not invited.
 */
export function cgInviteParams(): Record<string, string> | null {
  try {
    return sdk?.game.inviteParams ?? null;
  } catch {
    return null;
  }
}

/** One invite param by key (null when missing / SDK absent). */
export function cgGetInviteParam(key: string): string | null {
  try {
    return sdk?.game.getInviteParam(key) ?? null;
  } catch {
    return null;
  }
}

type JoinRoomListener = (params: Record<string, string>) => void;
const joinListeners = new Set<JoinRoomListener>();
let sdkJoinListener: JoinRoomListener | null = null;

/**
 * Fired when an already-in-game player accepts an invite (friends drawer /
 * notification). They should be sent to the room described by the params.
 */
export function onCgJoinRoom(l: JoinRoomListener): () => void {
  joinListeners.add(l);
  const attach = () => {
    if (sdkJoinListener || !sdk) return;
    sdkJoinListener = (params) => {
      for (const li of joinListeners) li(params ?? {});
    };
    try {
      sdk.game.addJoinRoomListener(sdkJoinListener);
    } catch { /* ignore */ }
  };
  attach();
  void initCrazyGames().then(attach); // cover the not-yet-inited subscribe race
  return () => {
    joinListeners.delete(l);
    if (joinListeners.size === 0 && sdk && sdkJoinListener) {
      try {
        sdk.game.removeJoinRoomListener(sdkJoinListener);
      } catch { /* ignore */ }
      sdkJoinListener = null;
    }
  };
}

/**
 * CrazyGames-hosted invite link for the given room params. Returns null when
 * the SDK is unavailable — callers then fall back to the plain ?join= URL.
 */
export async function cgInviteLink(params: Record<string, string>): Promise<string | null> {
  try {
    if (!sdk) return null;
    return await sdk.game.inviteLink(params);
  } catch {
    return null;
  }
}
