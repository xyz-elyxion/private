// CrazyGames account linking (server-side).
//
// The client fetches a short-lived JWT from the CrazyGames SDK
// (`SDK.user.getUserToken()`) and POSTs it here. We verify the token against
// CrazyGames' public key (fetched fresh per verification, as their docs
// recommend, since the key can rotate) and only then store the platform's
// `userId` on the local account row. No payment data ever touches the client;
// if CrazyGames/Xsolla purchases are enabled later, purchases are validated
// server-to-server the same way.
//
// Token payload (per https://docs.crazygames.com/sdk/user/):
//   { userId, gameId, username, profilePictureUrl, iat, exp }

import { Router } from 'express';
import { accountId, startSession } from './auth';
import { linkCrazyGamesAccount, findUserById, findUserByCrazyGamesId } from './db';

const CG_PUBLIC_KEY_URL = 'https://sdk.crazygames.com/publicKey.json';

type CgTokenPayload = {
  userId: string;
  gameId: string;
  username: string;
  profilePictureUrl?: string;
  iat: number;
  exp: number;
};

// Minimal RS256 JWT verifier on Node's webcrypto — no new dependency. The
// token is ~1KB, verification runs once per login, so perf is irrelevant.
async function verifyCgToken(token: string): Promise<CgTokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const [h64, p64, s64] = parts;
  const b64url = (s: string) => Buffer.from(s, 'base64url');

  const header = JSON.parse(b64url(h64).toString('utf8')) as { alg?: string; typ?: string };
  if (header.alg !== 'RS256') throw new Error('alg');

  const payload = JSON.parse(b64url(p64).toString('utf8')) as CgTokenPayload;
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) throw new Error('expired');
  if (!payload.userId) throw new Error('payload');

  // Fetch the public key fresh each time (docs recommend this; the key can
  // rotate). Fail closed if CrazyGames is unreachable.
  const keyRes = await fetch(CG_PUBLIC_KEY_URL, { signal: AbortSignal.timeout(5_000) });
  if (!keyRes.ok) throw new Error('key_fetch');
  const { publicKey } = (await keyRes.json()) as { publicKey: string };
  if (!publicKey) throw new Error('key_missing');

  const key = await crypto.subtle.importKey(
    'spki',
    pemToSpki(publicKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const data = new Uint8Array(Buffer.from(`${h64}.${p64}`));
  const sig = new Uint8Array(b64url(s64));
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!ok) throw new Error('signature');
  return payload;
}

function pemToSpki(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(body, 'base64'));
}

export const crazyGamesRouter = Router();

// POST /api/auth/crazygames { token } — verify + link the CrazyGames account
// to the local account. Works for guests too: the platform identity is
// recorded on whatever account (or new session) the browser carries.
crazyGamesRouter.post('/auth/crazygames', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token) {    res.status(400).json({ error: 'bad_token' });
    return;
  }
  try {
    const payload = await verifyCgToken(token);
    const id = accountId(req);
    if (!id) {
      // No local account: the CrazyGames identity alone can't create one
      // (progression is account-keyed). Tell the client to offer registration.
      res.status(409).json({ error: 'no_local_account', cgUser: { username: payload.username } });
      return;
    }
    const user = findUserById(id);
    if (!user) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    // Link one-to-one; if this CrazyGames identity is already bound to a
    // different local account, tell the client instead of silently rebinding.
    const existing = findUserByCrazyGamesId(payload.userId);
    if (existing && existing.id !== id) {
      res.status(409).json({ error: 'already_linked', cgUser: { username: payload.username } });
      return;
    }
    linkCrazyGamesAccount(id, payload.userId);
    res.json({ ok: true, cgUser: { userId: payload.userId, username: payload.username } });
  } catch (e) {
    const code = (e as Error)?.message ?? 'error';
    res.status(401).json({ error: 'invalid_token', detail: code });
  }
});

// startSession is imported for future flows where a CrazyGames login should
// mint a fresh local session; the current flow links into the existing one.
void startSession;
