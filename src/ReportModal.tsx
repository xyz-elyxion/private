import { useEffect, useState } from 'react';
import type { PlayerScore } from './game/types';

type ReportReason = 'cheating' | 'harassment' | 'inappropriate_name' | 'griefing' | 'other';

const REASONS: { id: ReportReason; label: string }[] = [
  { id: 'cheating', label: 'Cheating' },
  { id: 'harassment', label: 'Harassment' },
  { id: 'inappropriate_name', label: 'Inappropriate name' },
  { id: 'griefing', label: 'Griefing' },
  { id: 'other', label: 'Other' },
];

const ERRORS: Record<string, string> = {
  bad_report: 'Choose a reason and try again.',
  rate_limited: 'You have sent too many reports recently.',
  reports_unavailable: 'Reports are temporarily unavailable.',
  server_error: 'The report could not be submitted.',
};

export function ReportModal({
  target,
  onClose,
}: {
  target: PlayerScore;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason>('cheating');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          targetId: target.id,
          targetName: target.name,
          reason,
          details: details.trim(),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) setSent(true);
      else setError(ERRORS[data.error ?? ''] ?? 'The report could not be submitted.');
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role='dialog'
      aria-modal='true'
      aria-label={`Report ${target.name}`}
      className='fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className='w-[440px] max-w-[94vw] overflow-hidden rounded-xl border border-rose-400/30 bg-zinc-950/95 font-mono shadow-2xl'>
        <div className='flex items-center justify-between border-b border-white/10 px-6 py-4'>
          <div>
            <div className='text-[10px] uppercase tracking-[0.2em] text-rose-300'>Player report</div>
            <div className='mt-1 text-sm text-white'>Report {target.name}</div>
          </div>
          <button
            type='button'
            onClick={onClose}
            className='text-[11px] uppercase tracking-[0.16em] text-white/45 hover:text-white'
          >
            Close
          </button>
        </div>

        {sent ? (
          <div className='px-6 py-10 text-center'>
            <div className='text-2xl text-emerald-300'>Submitted</div>
            <p className='mt-2 text-sm text-white/60'>Thanks. The report was sent to moderation.</p>
            <button
              type='button'
              onClick={onClose}
              className='mt-6 rounded-md bg-rose-400 px-5 py-2 text-xs font-bold uppercase tracking-[0.14em] text-zinc-950 hover:bg-rose-300'
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className='px-6 py-5'>
              <label className='block text-[10px] uppercase tracking-[0.2em] text-white/45'>Reason</label>
              <select
                value={reason}
                onChange={(event) => setReason(event.target.value as ReportReason)}
                className='mt-2 w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-rose-300/60'
              >
                {REASONS.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>

              <label className='mt-5 block text-[10px] uppercase tracking-[0.2em] text-white/45'>Details</label>
              <textarea
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                maxLength={2000}
                rows={5}
                placeholder='Add useful context, if needed.'
                className='mt-2 w-full resize-y rounded-md border border-white/15 bg-black/40 px-3 py-2 text-sm leading-relaxed text-white outline-none focus:border-rose-300/60'
              />
              {error && <p className='mt-3 text-xs text-rose-300'>{error}</p>}
            </div>
            <div className='flex items-center justify-between border-t border-white/10 px-6 py-4'>
              <button
                type='button'
                onClick={onClose}
                className='text-[11px] uppercase tracking-[0.16em] text-white/45 hover:text-white/75'
              >
                Cancel
              </button>
              <button
                type='button'
                onClick={submit}
                disabled={busy}
                className='rounded-md bg-rose-400 px-5 py-2 text-xs font-bold uppercase tracking-[0.14em] text-zinc-950 hover:bg-rose-300 disabled:opacity-50'
              >
                {busy ? 'Sending...' : 'Submit report'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
