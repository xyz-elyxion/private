import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { CrosshairMark } from './Landing';

// ── Error pages ──────────────────────────────────────────────────────────────
// One themed component for every HTTP-style error (404, 500, 403, …). Renders
// the status code huge, its title, and the human-readable reason, with a way
// back into the game. Unknown codes fall back to a generic entry so any status
// can be displayed.

type ErrorInfo = { title: string; reason: string };

export const ERROR_REASONS: Record<number, ErrorInfo> = {
  400: { title: 'Bad Request', reason: 'The server could not understand the request. It may be malformed or missing required data.' },
  401: { title: 'Unauthorized', reason: 'You need to be signed in to view this page.' },
  403: { title: 'Forbidden', reason: 'You do not have permission to access this page. If you believe this is a mistake, contact a moderator.' },
  404: { title: 'Not Found', reason: 'This page does not exist — it may have been moved, renamed, or never existed in the first place.' },
  408: { title: 'Request Timeout', reason: 'The server took too long to respond. Try again in a moment.' },
  410: { title: 'Gone', reason: 'This page has been permanently removed.' },
  413: { title: 'Payload Too Large', reason: 'You tried to send more data than the server accepts.' },
  418: { title: "I'm a teapot", reason: 'The server refuses to brew coffee because it is, permanently and with pride, a teapot.' },
  429: { title: 'Too Many Requests', reason: 'You are sending requests too quickly. Slow down and try again shortly.' },
  500: { title: 'Internal Server Error', reason: 'Something went wrong on our end while handling your request. The error has been noted — try again shortly.' },
  502: { title: 'Bad Gateway', reason: 'The server received an invalid response from an upstream service.' },
  503: { title: 'Service Unavailable', reason: 'The server is temporarily down for maintenance or overloaded. Check back soon.' },
  504: { title: 'Gateway Timeout', reason: 'An upstream service took too long to respond.' },
};

const FALLBACK: ErrorInfo = {
  title: 'Unexpected Error',
  reason: 'An unexpected error occurred while handling your request.',
};

export function ErrorPage({ code }: { code: number }) {
  const info = ERROR_REASONS[code] ?? FALLBACK;

  // Document title so the tab reflects the error too.
  useEffect(() => {
    document.title = `${code} · ${info.title} — Elyxion`;
    return () => {
      document.title = 'Elyxion';
    };
  }, [code, info.title]);

  return (
    <div className='relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#05070c] px-6 text-center'>
      {/* Ambient backdrop — same cyan/red grid-glow idiom as the landing page. */}
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-0 opacity-60'
        style={{
          background:
            'radial-gradient(60% 50% at 50% 35%, rgba(34,211,238,0.10) 0%, transparent 70%), radial-gradient(40% 40% at 50% 80%, rgba(244,63,94,0.08) 0%, transparent 70%)',
        }}
      />
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-0 opacity-[0.05]'
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
        }}
      />

      <div className='relative flex items-center gap-3 font-display text-[11px] font-bold uppercase tracking-[0.3em] text-cyan-200/90'>
        <CrosshairMark size={18} />
        Elyxion
      </div>

      {/* The code, huge, with a scanline glitch treatment on the 5xx family. */}
      <div
        className={`relative mt-6 select-none font-display text-[22vw] leading-none font-black tracking-tighter sm:text-[9rem] ${
          code >= 500 ? 'text-rose-400' : 'text-cyan-300'
        }`}
        style={{
          textShadow:
            code >= 500
              ? '0 0 40px rgba(244,63,94,0.35), 3px 0 0 rgba(34,211,238,0.25), -3px 0 0 rgba(244,63,94,0.25)'
              : '0 0 40px rgba(34,211,238,0.35), 2px 0 0 rgba(244,63,94,0.2), -2px 0 0 rgba(34,211,238,0.2)',
        }}
      >
        {code}
      </div>

      <h1 className='mt-2 font-display text-xl font-bold uppercase tracking-[0.24em] text-white'>
        {info.title}
      </h1>
      <p className='mt-4 max-w-md text-sm leading-relaxed text-white/60'>{info.reason}</p>

      <div className='mt-10 flex flex-wrap items-center justify-center gap-4'>
        <Link
          to='/play'
          className='rounded-md border border-cyan-300/40 bg-cyan-300/10 px-6 py-2.5 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-cyan-200 transition hover:border-cyan-300/70 hover:bg-cyan-300/20'
        >
          Back to the arena
        </Link>
        <Link
          to='/'
          className='rounded-md border border-white/15 px-6 py-2.5 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-white/70 transition hover:border-white/35 hover:text-white'
        >
          Home
        </Link>
      </div>

      <p className='mt-8 text-[11px] uppercase tracking-[0.2em] text-white/25'>
        Error code: {code}
      </p>
    </div>
  );
}

export default ErrorPage;
