import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CrosshairMark } from './pages/Landing';

// ── Legal documents ──────────────────────────────────────────────────────────
//
// Single source of truth for the game's Terms of Service and Privacy Policy.
// Rendered three ways:
//   • full pages at /legal/terms and /legal/privacy (LegalPage, routed in main.tsx)
//   • an in-modal viewer when the player is signing up / logging in (LegalDocModal)
//   • a first-visit consent gate on the landing page (LegalGate)
//
// Portal-agnostic: the docs reference the platform the game is played on
// (CrazyGames etc.) without assuming any specific host, and never name a
// specific domain so the same bundle works everywhere.

export const LEGAL_VERSION = 1;
export const LEGAL_UPDATED = '2026-09-12';

export type LegalDoc = {
  id: 'terms' | 'privacy';
  title: string;
  intro: string;
  sections: Array<{ heading: string; body: string[] }>;
};

export const TERMS: LegalDoc = {
  id: 'terms',
  title: 'Terms of Service',
  intro:
    `These Terms of Service ("Terms") govern your use of Elyxion ("the game"), ` +
    `a free browser multiplayer shooter. By playing the game, creating an account, ` +
    `or otherwise using it, you agree to these Terms.`,
  sections: [
    {
      heading: '1. Who can play',
      body: [
        'The game is rated PEGI 12 and is intended for players aged 12 and up. It contains depictions of non-realistic violence between stylized characters.',
        'If you are under 13, you may not create an account. If you are a minor, you should have permission from a parent or guardian before playing, and your parent or guardian accepts these Terms on your behalf.',
        'You must comply with any additional age or regional requirements imposed by the platform you play on.',
      ],
    },
    {
      heading: '2. The game is provided free of charge',
      body: [
        'The game is free to play. There are currently no real-money purchases inside the game. Cosmetic items are earned through play with in-game credits and have no real-world monetary value.',
        'If a paid option is ever introduced, it will be processed through the platform you are playing on (for example CrazyGames) and that platform\'s payment terms will apply. We never see or store your payment details.',
      ],
    },
    {
      heading: '3. Accounts and guest play',
      body: [
        'You can play as a guest without an account, or create a free account with a username and password. An email address is optional and is used only for password recovery.',
        'You are responsible for keeping your password safe and for activity that happens under your account. Pick a username that does not impersonate others, advertise, or contain offensive content. Usernames that violate these rules may be changed or removed.',
        'Accounts are provided for your personal use only and may not be sold, shared, or transferred.',
      ],
    },
    {
      heading: '4. Fair play and acceptable use',
      body: [
        'You agree not to: cheat, exploit bugs, or use third-party software that gives an unfair advantage; automate gameplay; attack, overload, or reverse-engineer the game servers to disrupt them; harass, threaten, hate-speak, or sexually harass other players in chat or usernames; upload or link illegal, harmful, or objectionable content.',
        'Multiplayer chat is filtered and may be disabled by the hosting platform. Severe or repeated violations can result in a chat block or account suspension.',
        'If you find an exploit, please report it through the in-game Feedback form instead of using or sharing it.',
      ],
    },
    {
      heading: '5. User content and feedback',
      body: [
        'Feedback, bug reports, and suggestions you send us may be used to improve the game without obligation or compensation to you.',
        'You keep ownership of content you create, but grant us a limited license to store and display what is needed to run the game (for example your chosen username, equipped cosmetics, and match results on leaderboards).',
      ],
    },
    {
      heading: '6. Playing on other platforms',
      body: [
        'The game may be hosted on gaming portals such as CrazyGames. When you play there, that platform\'s own terms of service, cookies, and privacy notices also apply to you, in addition to these Terms.',
        'On those platforms, advertising shown around the game is served and controlled by the platform, not by us. We never sell ads ourselves.',
        'Progression linked to a CrazyGames account is tied to that account; progress made as a guest may not transfer.',
      ],
    },
    {
      heading: '7. Availability and changes',
      body: [
        'The game is provided "as is". Features, game modes, servers, cosmetics, and leaderboards may change, pause, or be discontinued at any time. There is no guarantee of uninterrupted or error-free service.',
        'The game is open source under its license; the source code is available to the public on request.',
      ],
    },
    {
      heading: '8. Disclaimers and liability',
      body: [
        'To the maximum extent permitted by law, the game\'s creators are not liable for indirect, incidental, or consequential damages, lost data, lost progress, or lost profits arising from your use of the game.',
        'Nothing in these Terms limits liability that cannot be limited by law, such as liability for gross negligence, willful misconduct, or personal injury.',
      ],
    },
    {
      heading: '9. Suspension and termination',
      body: [
        'We may suspend or terminate access for conduct that breaks these Terms, endangers other players, or endangers the service itself.',
        'You can stop playing at any time and request deletion of your account data (see the Privacy Policy).',
      ],
    },
    {
      heading: '10. Changes to these Terms',
      body: [
        'We may update these Terms as the game evolves. Material changes are announced in-game or on the game\'s page. Continuing to play after a change means you accept the updated Terms.',
      ],
    },
    {
      heading: '11. Contact',
      body: [
        'Questions about these Terms can be sent through the in-game Feedback form or through the project\'s public repository.',
      ],
    },
  ],
};

export const PRIVACY: LegalDoc = {
  id: 'privacy',
  title: 'Privacy Policy',
  intro:
    `This Privacy Policy explains what data the game collects, why, and the choices ` +
    `you have. It applies to the game wherever it is hosted, including portal embeds ` +
    `such as CrazyGames.`,
  sections: [
    {
      heading: '1. Summary',
      body: [
        'We collect the minimum needed to run a multiplayer game: your account details if you register, gameplay statistics, and technical session data. We do not sell your data. We do not run our own ad network or third-party ad tracking; advertising on portal embeds is handled entirely by the portal.',
      ],
    },
    {
      heading: '2. Data we collect',
      body: [
        'Account data (only if you register): username, hashed password, optional email address for password recovery, admin/verified flags.',
        'Gameplay data: match results (kills, deaths, accuracy, wins), XP, level, credits, equipped cosmetics, challenge progress, and ranked statistics. This is required for progression, the Locker, and leaderboards.',
        'Session data: an httpOnly session cookie (or a session token on cross-origin portal embeds) that keeps you logged in; a random visitor identifier for rate limiting.',
        'Content you submit: feedback and bug reports you send voluntarily.',
        'Local settings: graphics, audio, sensitivity, and keybind preferences stored in your browser\'s local storage on your device only.',
      ],
    },
    {
      heading: '3. CrazyGames and platform data',
      body: [
        'When you play on CrazyGames, the CrazyGames SDK is loaded. If you are signed in on CrazyGames and connect your account, the game receives your CrazyGames user ID, username, and avatar image solely to display your profile and link your progress. The CrazyGames SDK may also load platform advertising and report gameplay events (for example that gameplay started) to the platform.',
        'That data is processed by CrazyGames under their own privacy policy, available on their website. We never receive your CrazyGames password or payment details.',
        'When you play on any other portal, that portal\'s privacy notice applies to anything it collects.',
      ],
    },
    {
      heading: '4. How data is used',
      body: [
        'To operate the game: authentication, matchmaking, rooms, chat, progression, cosmetics, leaderboards, replays.',
        'To keep the service safe: rate limiting, cheat and abuse prevention, and enforcement of the Terms.',
        'To improve the game: aggregate feedback and statistics. We do not build advertising profiles and we do not sell or rent personal data.',
      ],
    },
    {
      heading: '5. Cookies and local storage',
      body: [
        'The game uses one essential session cookie for login (httpOnly, SameSite) and a visitor identifier cookie for rate limiting. There are no tracking or advertising cookies set by us.',
        'Local storage stores your in-game settings and (on portal embeds) a session token so accounts keep working where third-party cookies are blocked. Clearing your browser storage removes both.',
      ],
    },
    {
      heading: '6. Data sharing',
      body: [
        'Your username, level, cosmetics, and match statistics are publicly visible on leaderboards and public profile pages — this is inherent to a competitive multiplayer game.',
        'Hosting infrastructure (the game server) and the platform you play on technically process data to deliver the service. There are no other recipients, and no international sale of data.',
      ],
    },
    {
      heading: '7. Retention and deletion',
      body: [
        'Account and gameplay data is kept while your account exists so your progress persists. Guest statistics tied to a browser identifier are retained in aggregate for leaderboards.',
        'You can request deletion of your account and associated personal data at any time via the in-game Feedback form or the game\'s public repository. We will remove your account, email, and identifiable statistics within a reasonable period. Aggregate, anonymized statistics may be retained.',
      ],
    },
    {
      heading: '8. Children',
      body: [
        'The game is rated PEGI 12 and is not intended for children under 13 to hold accounts. We do not knowingly collect personal data from children under 13. If you believe a child has registered an account, contact us and it will be removed.',
      ],
    },
    {
      heading: '9. Security',
      body: [
        'Passwords are stored hashed, sessions use httpOnly cookies, and the game server validates gameplay server-side. No online service can promise perfect security, but we take reasonable measures to protect the data we hold.',
      ],
    },
    {
      heading: '10. Your rights',
      body: [
        'Depending on your region (for example the EU/EEA under GDPR), you may have rights to access, correct, export, or delete your personal data, and to object to or restrict processing. Contact us as described below and we will respond within a reasonable time.',
      ],
    },
    {
      heading: '11. Changes to this policy',
      body: [
        'If this policy changes materially, the updated version will be shown in-game and the "Last updated" date will change. Continued play after that constitutes acceptance.',
      ],
    },
    {
      heading: '12. Contact',
      body: [
        'For privacy questions or data requests, use the in-game Feedback form or reach the maintainers through the project\'s public repository.',
      ],
    },
  ],
};

export const LEGAL_DOCS = { terms: TERMS, privacy: PRIVACY } as const;

// ── Consent persistence ──────────────────────────────────────────────────────

const STORAGE_KEY = 'elyxion-legal-consent';

type StoredConsent = { v: number; ts: number };

export function getLegalAcceptance(): StoredConsent | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredConsent>;
    if (typeof parsed.v !== 'number' || typeof parsed.ts !== 'number') return null;
    return parsed as StoredConsent;
  } catch {
    return null;
  }
}

/** True when the player has accepted the CURRENT version of the legal docs. */
export function hasAcceptedLegal(): boolean {
  return getLegalAcceptance()?.v === LEGAL_VERSION;
}

export function acceptLegal(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: LEGAL_VERSION, ts: Date.now() } satisfies StoredConsent));
  } catch {
    /* storage unavailable (private mode etc.) — consent simply isn't persisted */
  }
}

// ── Doc renderer ─────────────────────────────────────────────────────────────

export function LegalSections({ doc }: { doc: LegalDoc }) {
  return (
    <div className='text-[13px] leading-relaxed text-white/65'>
      <p className='mb-6 text-white/75'>{doc.intro}</p>
      {doc.sections.map((s) => (
        <section key={s.heading} className='mb-5'>
          <h3 className='mb-1.5 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-cyan-200/90'>
            {s.heading}
          </h3>
          {s.body.map((p, i) => (
            <p key={i} className='mb-1.5'>
              {p}
            </p>
          ))}
        </section>
      ))}
    </div>
  );
}

// ── In-modal document viewer ─────────────────────────────────────────────────
// Opens above other modals (z-[80] > login modal z-[70]) so the signup flow can
// show the full doc without navigating away from the game.

export function LegalDocModal({
  doc,
  onClose,
}: {
  doc: 'terms' | 'privacy';
  onClose: () => void;
}) {
  const d = LEGAL_DOCS[doc];
  // Own Escape handler — parents suppress theirs while this is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role='dialog'
      aria-modal='true'
      aria-label={d.title}
      className='fixed inset-0 z-[80] flex items-center justify-center bg-black/90 p-4 backdrop-blur-md'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className='deck-bg flex max-h-[86vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-cyan-500/30 bg-zinc-950/95 shadow-2xl'>
        <div className='flex items-center justify-between border-b border-white/10 px-6 py-4'>
          <h2 className='text-[12px] font-bold uppercase tracking-[0.18em] text-cyan-300'>{d.title}</h2>
          <button
            onClick={onClose}
            aria-label='Close'
            className='rounded-md px-2 py-1 text-lg leading-none text-white/40 transition hover:bg-white/10 hover:text-white/80'
          >
            ×
          </button>
        </div>
        <div className='min-h-0 flex-1 overflow-y-auto px-6 py-5'>
          <p className='mb-5 font-mono text-[10px] uppercase tracking-[0.2em] text-white/35'>
            Last updated {LEGAL_UPDATED}
          </p>
          <LegalSections doc={d} />
        </div>
        <div className='border-t border-white/10 px-6 py-3'>
          <button
            onClick={onClose}
            className='text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-300/80 hover:text-cyan-200'
          >
            ← Back
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Consent checkbox (login / register) ──────────────────────────────────────

export function LegalAgreeCheckbox({
  checked,
  onChange,
  onOpenDoc,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  onOpenDoc: (doc: 'terms' | 'privacy') => void;
}) {
  return (
    <label className='mt-5 flex cursor-pointer items-start gap-2.5 select-none'>
      <input
        type='checkbox'
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className='mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-cyan-400'
      />
      <span className='text-[11.5px] leading-relaxed text-white/55'>
        I have read and agree to the{' '}
        <button
          type='button'
          onClick={(e) => {
            e.preventDefault();
            onOpenDoc('terms');
          }}
          className='text-cyan-300 underline-offset-2 hover:underline'
        >
          Terms of Service
        </button>{' '}
        and{' '}
        <button
          type='button'
          onClick={(e) => {
            e.preventDefault();
            onOpenDoc('privacy');
          }}
          className='text-cyan-300 underline-offset-2 hover:underline'
        >
          Privacy Policy
        </button>
        , including that the game is rated PEGI 12.
      </span>
    </label>
  );
}

// ── First-visit consent gate (landing page) ─────────────────────────────────
// Shown once per browser until accepted. "Not now" defers — it will appear
// again on the next visit, but the player is never blocked from reading the
// docs or from playing as a guest.

export function LegalGate({ onAccepted }: { onAccepted: () => void }) {
  const [agree, setAgree] = useState(false);
  const [doc, setDoc] = useState<'terms' | 'privacy' | null>(null);

  const accept = () => {
    if (!agree) return;
    acceptLegal();
    onAccepted();
  };

  return (
    <div
      role='dialog'
      aria-modal='true'
      aria-label='Terms and privacy'
      className='fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onAccepted();
      }}
    >
      <div className='deck-bg w-[480px] max-w-[94vw] overflow-hidden rounded-2xl border border-cyan-500/30 bg-zinc-950/95 shadow-2xl'>
        <div className='flex items-center gap-3 border-b border-white/10 px-6 py-4'>
          <CrosshairMark size={18} />
          <h2 className='text-[12px] font-bold uppercase tracking-[0.18em] text-cyan-300'>
            Before you deploy
          </h2>
        </div>
        <div className='px-6 py-5'>
          <p className='text-[13px] leading-relaxed text-white/65'>
            Elyxion is a free multiplayer shooter rated <span className='text-white/85'>PEGI 12</span>. Playing
            creates no account by default, but the game does process the data described in our policies.
          </p>
          <div className='mt-4 flex gap-2'>
            <button
              onClick={() => setDoc('terms')}
              className='rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/70 transition hover:bg-white/10'
            >
              Terms of Service
            </button>
            <button
              onClick={() => setDoc('privacy')}
              className='rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/70 transition hover:bg-white/10'
            >
              Privacy Policy
            </button>
          </div>
          <label className='mt-5 flex cursor-pointer items-start gap-2.5 select-none'>
            <input
              type='checkbox'
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              className='mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-cyan-400'
            />
            <span className='text-[11.5px] leading-relaxed text-white/55'>
              I have read and agree to the Terms of Service and Privacy Policy.
            </span>
          </label>
        </div>
        <div className='flex items-center justify-between border-t border-white/10 px-6 py-4'>
          <button
            onClick={() => onAccepted()}
            className='text-[11px] uppercase tracking-[0.16em] text-white/40 hover:text-white/70'
          >
            Not now
          </button>
          <button
            onClick={accept}
            disabled={!agree}
            className='rounded-lg bg-cyan-400 px-6 py-2.5 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40'
          >
            Continue
          </button>
        </div>
      </div>
      {doc && <LegalDocModal doc={doc} onClose={() => setDoc(null)} />}
    </div>
  );
}

// ── Full legal pages (/legal/terms, /legal/privacy) ──────────────────────────

export function LegalPage() {
  const { doc: docParam } = useParams<{ doc?: string }>();
  const doc: LegalDoc = docParam === 'privacy' ? PRIVACY : TERMS;
  const other: LegalDoc = doc.id === 'terms' ? PRIVACY : TERMS;

  return (
    <div className='deck-bg min-h-full text-white'>
      <div className='deck-scan pointer-events-none fixed inset-0 z-10' aria-hidden='true' />
      <div className='relative mx-auto max-w-3xl px-5 py-10 sm:px-8'>
        <div className='mb-8 flex items-center justify-between gap-4'>
          <Link
            to='/'
            className='flex items-center gap-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.28em] text-white/50 transition hover:text-white/85'
          >
            ← Back
          </Link>
          <div className='flex items-center gap-2.5'>
            <CrosshairMark size={16} />
            <span className='font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-white/50'>
              Elyxion
            </span>
          </div>
        </div>

        <header className='mb-8 border-b border-white/10 pb-6'>
          <h1 className='font-display text-4xl font-bold uppercase tracking-[0.08em] text-white/90 sm:text-5xl'>
            {doc.title}
          </h1>
          <p className='mt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/35'>
            Last updated {LEGAL_UPDATED} · applies wherever the game is hosted
          </p>
        </header>

        <LegalSections doc={doc} />

        <div className='mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-5'>
          <Link
            to={`/legal/${other.id}`}
            className='text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-300 underline-offset-4 hover:underline'
          >
            {other.title} →
          </Link>
          <Link
            to='/'
            className='rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/70 transition hover:bg-white/10'
          >
            Back to the arena
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── Small footer links row (landing + auth surfaces) ─────────────────────────

export function LegalFooterLinks({ className = '' }: { className?: string }): ReactNode {
  return (
    <span className={`flex items-center gap-3 ${className}`}>
      <Link to='/legal/terms' className='transition hover:text-white/90'>
        Terms
      </Link>
      <span className='text-white/15'>·</span>
      <Link to='/legal/privacy' className='transition hover:text-white/90'>
        Privacy
      </Link>
    </span>
  );
}
