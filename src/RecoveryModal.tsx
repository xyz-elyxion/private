import { useEffect, useState } from 'react';

// Profile recovery: optional, account-less recovery. A server-minted code that
// maps to a player_id; entering it on a new browser re-binds the session cookie
// to the existing account (solves "cleared cookies / new device wiped my progress").
// No email/password — just a code the player saves.

type RecoveryCode = {
  id: number;
  code: string;
  created_at: number;
  expires_at: number;
  used: number;
  used_at: number;
};

type IssueResult = { ok: true; code: string; expiresAt: number } | { ok: false; reason: string };
type VerifyResult =
  | { ok: true; playerId: string; secret: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' };

const TAB = { ISSUE: 'issue', VERIFY: 'verify', CODES: 'codes' } as const;

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function expiresIn(ts: number): string {
  const s = Math.floor((ts - Date.now()) / 1000);
  if (s <= 0) return 'Expired';
  if (s < 3600) return `${Math.floor(s / 60)}m remaining`;
  if (s < 86400) return `${Math.floor(s / 3600)}h remaining`;
  return `${Math.floor(s / 86400)}d remaining`;
}

export function RecoveryModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<typeof TAB[keyof typeof TAB]>(TAB.CODES);
  const [codes, setCodes] = useState<RecoveryCode[]>([]);
  const [issueCode, setIssueCode] = useState<string>('');
  const [issueExpires, setIssueExpires] = useState<number>(0);
  const [verifying, setVerifying] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load existing codes for the current account.
  useEffect(() => {
    let active = true;
    fetch('/api/recovery/codes', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('fetch'))))
      .then((d: { codes?: RecoveryCode[] }) => {
        if (active) setCodes((d.codes ?? []).filter((c) => !c.used));
      })
      .catch(() => {})
      .finally(() => {
        if (active) setVerifying(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const issue = async () => {
    setError(null);
    try {
      const r = await fetch('/api/recovery/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      const d = (await r.json()) as IssueResult;
      if (d.ok) {
        setIssueCode(d.code);
        setIssueExpires(d.expiresAt);
        setTab(TAB.CODES);
        // Refresh the codes list.
        const r2 = await fetch('/api/recovery/codes', { credentials: 'include' });
        if (r2.ok) {
          const d2 = (await r2.json()) as { codes?: RecoveryCode[] };
          setCodes((d2.codes ?? []).filter((c) => !c.used));
        }
      } else {
        setError(d.reason === 'unknown' ? 'Could not issue a code' : `Error: ${d.reason}`);
      }
    } catch {
      setError('Network error — try again');
    }
  };

  const verify = async () => {
    setError(null);
    setVerifying(true);
    setVerifyResult(null);
    try {
      const r = await fetch('/api/recovery/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code: verifyCode.trim().toLowerCase() }),
      });
      const d = (await r.json()) as VerifyResult;
      setVerifyResult(d);
      if (d.ok) {
        setTab(TAB.CODES);
      } else {
        const msg =
          d.reason === 'unknown'
            ? 'That code doesn’t exist'
            : d.reason === 'expired'
              ? 'That code has expired'
              : d.reason === 'used'
                ? 'That code was already used'
                : 'Invalid code';
        setError(msg);
      }
    } catch {
      setError('Network error — try again');
    } finally {
      setVerifying(false);
    }
  };

  const redeem = async () => {
    if (!verifyResult?.ok) return;
    setRedeeming(true);
    try {
      const r = await fetch('/api/recovery/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code: verifyCode.trim().toLowerCase() }),
      });
      if (r.ok) {
        setError(null);
        setTab(TAB.CODES);
        // Refresh codes.
        const r2 = await fetch('/api/recovery/codes', { credentials: 'include' });
        if (r2.ok) {
          const d2 = (await r2.json()) as { codes?: RecoveryCode[] };
          setCodes((d2.codes ?? []).filter((c) => !c.used));
        }
      } else {
        const d = (await r.json()) as { error?: string };
        setError(d.error === 'wrong_account' ? 'This code belongs to a different account' : 'Could not redeem');
      }
    } catch {
      setError('Network error — try again');
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Profile recovery"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="deck-bg w-[520px] max-w-[94vw] overflow-hidden rounded-2xl border border-cyan-500/30 bg-zinc-950/95 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-7 py-4">
          <h2 className="text-[12px] font-bold uppercase tracking-[0.18em] text-cyan-300">
            Profile Recovery
          </h2>
          <button
            onClick={onClose}
            className="text-[11px] uppercase tracking-[0.16em] text-white/40 hover:text-white/70"
          >
            Close
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/10 px-7">
          {(['issue', 'verify', 'codes'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setError(null);
              }}
              className={`px-4 py-3 text-[11px] font-bold uppercase tracking-[0.16em] transition ${
                tab === t
                  ? 'border-b-2 border-cyan-400 text-cyan-300'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="px-7 py-6">
          {/* ── Issue tab ──────────────────────────────────────────── */}
          {tab === TAB.ISSUE && (
            <>
              <p className="mb-4 text-[12px] leading-relaxed text-white/50">
                Issue a 6-character recovery code. Save it somewhere safe (a password
                manager, a note). If you ever clear your cookies or switch devices, enter
                this code on the new browser to reclaim your account — no email or password
                needed.
              </p>
              {issueCode ? (
                <div className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-5 text-center">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/70">
                    Your recovery code
                  </p>
                  <p className="mt-2 font-mono text-3xl font-extrabold tracking-[0.3em] text-emerald-200">
                    {issueCode}
                  </p>
                  <p className="mt-2 text-[11px] text-emerald-300/60">Expires {expiresIn(issueExpires)}</p>
                  <p className="mt-3 text-[11px] text-white/40">
                    Copy it now — we won’t show it again.
                  </p>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(issueCode).catch(() => {});
                    }}
                    className="mt-2 rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-200 transition hover:bg-emerald-400/20"
                  >
                    Copy code
                  </button>
                </div>
              ) : (
                <button
                  onClick={issue}
                  disabled={verifying}
                  className="w-full rounded-lg bg-cyan-400 px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-50"
                >
                  {verifying ? 'Issuing…' : 'Issue recovery code'}
                </button>
              )}
              {error && <div className="mt-4 text-[12px] text-rose-300">{error}</div>}
            </>
          )}

          {/* ── Verify tab ─────────────────────────────────────────── */}
          {tab === TAB.VERIFY && (
            <>
              <p className="mb-4 text-[12px] leading-relaxed text-white/50">
                Enter a recovery code to verify it maps to an account. If it’s valid and
                unused, you can then redeem it to bind your current session to that account.
              </p>
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && verify()}
                  placeholder="Enter 6-character code"
                  maxLength={6}
                  className="flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-cyan-400/60 uppercase"
                />
                <button
                  onClick={verify}
                  disabled={verifying || verifyCode.length < 6}
                  className="rounded-lg bg-cyan-400 px-4 py-2.5 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-50"
                >
                  {verifying ? '…' : 'Verify'}
                </button>
              </div>
              {verifyResult && (
                <div className="mt-4 rounded-lg border p-4">
                  {verifyResult.ok ? (
                    <div className="border-emerald-400/40 bg-emerald-400/10">
                      <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/70">Valid code</p>
                      <p className="mt-1 text-sm text-white/70">
                        This code maps to account {verifyResult.playerId.slice(0, 8)}…
                      </p>
                      <button
                        onClick={redeem}
                        disabled={redeeming}
                        className="mt-3 w-full rounded-lg bg-emerald-400 px-4 py-2 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-emerald-300 disabled:opacity-50"
                      >
                        {redeeming ? 'Redeeming…' : 'Redeem — bind this session to that account'}
                      </button>
                    </div>
                  ) : (
                    <div className="border-rose-400/40 bg-rose-400/10">
                      <p className="text-[10px] uppercase tracking-[0.2em] text-rose-300/70">Invalid code</p>
                      <p className="mt-1 text-sm text-rose-200">
                        {verifyResult.reason === 'unknown'
                          ? 'That code doesn’t exist'
                          : verifyResult.reason === 'expired'
                            ? 'This code has expired'
                            : 'This code was already used'}
                      </p>
                    </div>
                  )}
                </div>
              )}
              {error && <div className="mt-4 text-[12px] text-rose-300">{error}</div>}
            </>
          )}

          {/* ── Codes tab ──────────────────────────────────────────── */}
          {tab === TAB.CODES && (
            <>
              <p className="mb-4 text-[12px] leading-relaxed text-white/50">
                Your active recovery codes. Codes expire after 30 days and are single-use.
              </p>
              {codes.length === 0 ? (
                <div className="py-6 text-center">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-white/30">No active codes</p>
                  <p className="mt-1 text-[11px] text-white/40">Issue a code to be able to recover your account later.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {codes.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3"
                    >
                      <div className="font-mono text-lg font-extrabold tracking-[0.3em] text-cyan-200">
                        {c.code}
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">
                          Issued {timeAgo(c.created_at)}
                        </div>
                        <div className="text-[10px] uppercase tracking-[0.16em] text-emerald-300/60">
                          {expiresIn(c.expires_at)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-white/10 px-7 py-4">
          <p className="text-[10px] text-white/30">
            Recovery is optional. Without a code, clearing cookies loses progress.
          </p>
          <button
            onClick={onClose}
            className="rounded-lg bg-cyan-400 px-5 py-2 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
