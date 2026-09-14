// Standalone Moderation Panel (/moderation).
//
// Deliberately SEPARATE from the admin dashboard (/admin): this page is for the
// day-to-day moderation staff — `mod` and `jrmod` roles — and never exposes
// metrics, retention, players, feedback, or portal packaging. What a caller
// sees is driven by their server-side staff role (the same role tiers the
// /api/admin/moderation/* endpoints enforce):
//
//   jrmod — reports queue only (view + resolve/dismiss)
//   mod   — reports queue + quick ban + verified badge
//   admin — everything above + staff role management
//
// Gated client-side for UX; the server re-checks the role on every request.

import { useCallback, useEffect, useState } from 'react';
import { Gavel, Gamepad2, Inbox, ShieldAlert, UserCheck } from 'lucide-react';
import { useAuth, authHeaders, type StaffRole } from './auth';
import { apiUrl } from './game/urls';

// ── API shapes (mirror server/admin.ts + server/db.ts) ───────────────────────
type ModReport = {
  id: number;
  ts: number;
  reporterName: string;
  targetName: string;
  reason: string;
  detail: string;
  roomId: string;
  status: string;
  handledBy: string;
  handledAt: number;
};
type StaffRow = { id: string; username: string; role: StaffRole };

const ROLE_COLORS: Record<string, string> = {
  admin: 'text-rose-300 bg-rose-400/10 ring-rose-400/30',
  mod: 'text-amber-300 bg-amber-400/10 ring-amber-400/30',
  jrmod: 'text-cyan-300 bg-cyan-400/10 ring-cyan-400/30',
  player: 'text-white/50 bg-white/5 ring-white/15',
};

const BAN_DURATIONS = [
  { id: '1h', label: '1 hour' },
  { id: '6h', label: '6 hours' },
  { id: '1d', label: '1 day' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'permanent', label: 'Permanent' },
];

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  return new Date(ts).toLocaleDateString();
}

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(apiUrl(url), { ...authHeaders(), credentials: 'include' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function RoleChip({ role }: { role: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] ring-1 ${
        ROLE_COLORS[role] ?? ROLE_COLORS.player
      }`}
    >
      {role}
    </span>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur">
      <h2 className="mb-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-cyan-200/90">
        {title}
      </h2>
      {children}
    </section>
  );
}

const inputCls =
  'rounded-md bg-white/5 px-2.5 py-1.5 font-mono text-[12px] text-white/85 outline-none ring-1 ring-white/10 placeholder:text-white/30 focus:ring-cyan-400/40';

// ── Page ─────────────────────────────────────────────────────────────────────
export default function ModerationPanel() {
  const auth = useAuth();
  const staffRole: StaffRole = auth.account?.role ?? (auth.account?.isAdmin ? 'admin' : 'player');
  const isAdmin = staffRole === 'admin';
  const isMod = isAdmin || staffRole === 'mod';
  const isStaff = isMod || staffRole === 'jrmod';

  const [reports, setReports] = useState<ModReport[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<'open' | 'resolved' | 'dismissed' | 'all'>('open');
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [banTarget, setBanTarget] = useState('');
  const [banReason, setBanReason] = useState('');
  const [banDur, setBanDur] = useState('1d');
  const [verifyTarget, setVerifyTarget] = useState('');
  const [newRole, setNewRole] = useState<{ username: string; role: StaffRole }>({ username: '', role: 'jrmod' });

  const refresh = useCallback(() => {
    void getJSON<{ reports: ModReport[]; counts: Record<string, number> }>(
      `/api/admin/moderation/reports?status=${status}&limit=100`,
    ).then((d) => {
      if (d) {
        setReports(d.reports ?? []);
        setCounts(d.counts ?? {});
      }
    });
    if (isAdmin) void getJSON<{ staff: StaffRow[] }>('/api/admin/moderation/staff').then((d) => setStaff(d?.staff ?? []));
  }, [status, isAdmin]);
  useEffect(refresh, [refresh]);

  const post = async (url: string, body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      const r = await fetch(apiUrl(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setErr(
          data.error === 'insufficient_role'
            ? 'Your role does not allow this.'
            : data.error === 'not_found'
              ? 'No such account.'
              : 'Action failed.',
        );
        return false;
      }
      setMsg(okMsg);
      refresh();
      return true;
    } catch {
      setErr('Network error.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setReportStatus = (id: number, s: 'resolved' | 'dismissed') =>
    post(`/api/admin/moderation/reports/${id}/status`, { status: s }, `Report #${id} ${s}.`);

  const quickBan = (username: string) => {
    if (!username) return;
    void post('/api/admin/moderation/ban', { username, reason: banReason, duration: banDur }, `Banned ${username}.`);
  };

  // ── Gates ──
  if (!auth.ready) {
    return (
      <div className="deck-bg flex min-h-screen items-center justify-center font-mono text-sm text-white/60">
        Loading…
      </div>
    );
  }
  if (!auth.account || !isStaff) {
    return (
      <div className="deck-bg flex min-h-screen items-center justify-center font-mono text-sm">
        <div className="text-center">
          <p className="font-display text-2xl text-rose-300">403</p>
          <p className="mt-2 text-white/60">The moderation panel is staff-only.</p>
          <a href="/play" className="mt-3 inline-block text-cyan-300 hover:text-cyan-200">
            ← Back to the arena
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="deck-bg min-h-screen text-white">
      <div className="mx-auto max-w-5xl px-5 py-8">
        {/* Header */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/30">
              <Gavel className="h-5 w-5" strokeWidth={1.5} />
            </div>
            <div>
              <h1 className="font-display text-xl font-semibold tracking-[0.08em]">MODERATION</h1>
              <p className="text-[12px] text-white/40">Reports, bans &amp; staff — separate from the admin command deck.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <RoleChip role={staffRole} />
            <span className="text-[11px] text-white/35">{auth.account.username}</span>
            <a
              href="/play"
              className="flex items-center gap-1.5 rounded-md border border-white/15 px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-white/60 transition hover:border-cyan-400/50 hover:text-cyan-200"
            >
              <Gamepad2 className="h-3.5 w-3.5" strokeWidth={1.5} />
              Arena
            </a>
            {isAdmin && (
              <a
                href="/admin"
                className="flex items-center gap-1.5 rounded-md border border-white/15 px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-white/60 transition hover:border-cyan-400/50 hover:text-cyan-200"
              >
                <ShieldAlert className="h-3.5 w-3.5" strokeWidth={1.5} />
                Admin
              </a>
            )}
          </div>
        </header>

        {(msg || err) && (
          <p className={`mb-4 font-mono text-[12px] ${err ? 'text-rose-300' : 'text-emerald-300'}`}>{err || msg}</p>
        )}

        {/* Player reports */}
        <Panel title={`Player reports${counts.open ? ` — ${counts.open} open` : ''}`}>
          <div className="mb-3 flex gap-1">
            {(['open', 'resolved', 'dismissed', 'all'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`rounded-full px-2.5 py-1 text-[11px] tracking-wide transition ${
                  status === s ? 'bg-cyan-400/15 text-cyan-200' : 'text-white/45 hover:bg-white/5 hover:text-white/80'
                }`}
              >
                {s}
                {s === 'open' && counts.open ? ` (${counts.open})` : ''}
              </button>
            ))}
          </div>
          {!reports ? (
            <p className="font-mono text-[12px] text-white/40">Loading…</p>
          ) : reports.length === 0 ? (
            <p className="flex items-center gap-2 text-[12px] text-white/40">
              <Inbox className="h-4 w-4 text-white/25" strokeWidth={1.5} /> No reports.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-[12px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.16em] text-white/40">
                    <th className="py-1.5 pr-4 font-medium">When</th>
                    <th className="py-1.5 pr-4 font-medium">Reporter</th>
                    <th className="py-1.5 pr-4 font-medium">Target</th>
                    <th className="py-1.5 pr-4 font-medium">Reason</th>
                    <th className="py-1.5 pr-4 font-medium">Detail</th>
                    <th className="py-1.5 pr-4 font-medium" />
                  </tr>
                </thead>
                <tbody className="text-white/75">
                  {reports.map((r) => (
                    <tr key={r.id} className="border-t border-white/8 align-top">
                      <td className="whitespace-nowrap py-2 pr-4 text-white/45">{ago(r.ts)}</td>
                      <td className="py-2 pr-4">{r.reporterName}</td>
                      <td className="py-2 pr-4 text-cyan-200">{r.targetName}</td>
                      <td className="py-2 pr-4">
                        <span className="rounded bg-white/8 px-1.5 py-0.5 text-[11px] uppercase tracking-wide">{r.reason}</span>
                      </td>
                      <td className="max-w-[280px] break-words py-2 pr-4 text-white/55">{r.detail}</td>
                      <td className="py-2">
                        {r.status === 'open' ? (
                          <div className="flex gap-1.5">
                            <button
                              disabled={busy}
                              onClick={() => setReportStatus(r.id, 'resolved')}
                              className="rounded bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-300 ring-1 ring-emerald-400/25 transition hover:bg-emerald-400/20"
                            >
                              Resolve
                            </button>
                            <button
                              disabled={busy}
                              onClick={() => setReportStatus(r.id, 'dismissed')}
                              className="rounded bg-white/5 px-2 py-1 text-[11px] text-white/55 ring-1 ring-white/15 transition hover:bg-white/10"
                            >
                              Dismiss
                            </button>
                            {isMod && (
                              <button
                                disabled={busy}
                                onClick={() => quickBan(r.targetName)}
                                title={`Ban ${r.targetName} (${banDur})`}
                                className="rounded bg-rose-400/10 px-2 py-1 text-[11px] text-rose-300 ring-1 ring-rose-400/25 transition hover:bg-rose-400/20"
                              >
                                Ban
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-white/35">
                            {r.status} · {r.handledBy}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {staffRole === 'jrmod' && (
            <p className="mt-3 text-[11px] text-white/35">Your role: reports queue only — resolve/dismiss.</p>
          )}
        </Panel>

        {/* Quick actions (mod+) */}
        {isMod && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Panel title="Quick ban">
              <div className="flex flex-wrap items-end gap-2">
                <input
                  value={banTarget}
                  onChange={(e) => setBanTarget(e.target.value)}
                  placeholder="username"
                  className={`w-36 ${inputCls}`}
                />
                <select
                  value={banDur}
                  onChange={(e) => setBanDur(e.target.value)}
                  className={`px-2 py-1.5 ${inputCls}`}
                >
                  {BAN_DURATIONS.map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                </select>
                <input
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  placeholder="reason (optional)"
                  className={`min-w-[140px] flex-1 ${inputCls}`}
                />
                <button
                  disabled={busy || !banTarget.trim()}
                  onClick={() => quickBan(banTarget.trim())}
                  className="rounded-md bg-rose-400/10 px-3 py-1.5 text-[12px] text-rose-300 ring-1 ring-rose-400/30 transition hover:bg-rose-400/20 disabled:opacity-40"
                >
                  Ban
                </button>
              </div>
            </Panel>
            <Panel title="Verified badge">
              <div className="flex items-end gap-2">
                <input
                  value={verifyTarget}
                  onChange={(e) => setVerifyTarget(e.target.value)}
                  placeholder="username"
                  className={`w-36 ${inputCls}`}
                />
                <button
                  disabled={busy || !verifyTarget.trim()}
                  onClick={() => post('/api/admin/moderation/verify', { username: verifyTarget.trim(), verified: true }, `Verified ${verifyTarget.trim()}.`)}
                  className="flex items-center gap-1.5 rounded-md bg-cyan-400/10 px-3 py-1.5 text-[12px] text-cyan-300 ring-1 ring-cyan-400/30 transition hover:bg-cyan-400/20 disabled:opacity-40"
                >
                  <UserCheck className="h-3.5 w-3.5" strokeWidth={1.5} /> Verify
                </button>
                <button
                  disabled={busy || !verifyTarget.trim()}
                  onClick={() => post('/api/admin/moderation/verify', { username: verifyTarget.trim(), verified: false }, `Unverified ${verifyTarget.trim()}.`)}
                  className="rounded-md bg-white/5 px-3 py-1.5 text-[12px] text-white/60 ring-1 ring-white/15 transition hover:bg-white/10 disabled:opacity-40"
                >
                  Unverify
                </button>
              </div>
            </Panel>
          </div>
        )}

        {/* Staff roles (admin only) */}
        {isAdmin && (
          <div className="mt-4">
            <Panel title="Staff roles">
              <div className="mb-3 flex flex-wrap items-end gap-2">
                <input
                  value={newRole.username}
                  onChange={(e) => setNewRole({ ...newRole, username: e.target.value })}
                  placeholder="username"
                  className={`w-36 ${inputCls}`}
                />
                <select
                  value={newRole.role}
                  onChange={(e) => setNewRole({ ...newRole, role: e.target.value as StaffRole })}
                  className={`px-2 py-1.5 ${inputCls}`}
                >
                  <option value="admin">admin</option>
                  <option value="mod">mod</option>
                  <option value="jrmod">jrmod</option>
                  <option value="player">player</option>
                </select>
                <button
                  disabled={busy || !newRole.username.trim()}
                  onClick={() => post('/api/admin/moderation/staff/role', newRole, `${newRole.username} → ${newRole.role}.`)}
                  className="rounded-md bg-cyan-400/10 px-3 py-1.5 text-[12px] text-cyan-300 ring-1 ring-cyan-400/30 transition hover:bg-cyan-400/20 disabled:opacity-40"
                >
                  Set role
                </button>
              </div>
              {!staff ? (
                <p className="font-mono text-[12px] text-white/40">Loading…</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {staff.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 rounded-md bg-white/[0.04] px-2.5 py-1.5 ring-1 ring-white/10">
                      <span className="font-mono text-[12px] text-white/80">{m.username}</span>
                      <RoleChip role={m.role} />
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
