import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { getGoogleClientId, getGoogleClientSecret } from './accounts.js';
import { accountErrorCode, CodedAccountError } from './account-quota.js';
import { bt } from './i18n.js';
import { resolveOutboundFetch } from './proxy.js';

type LoginPhase = 'waiting' | 'exchanging' | 'saving' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
type Tokens = { access_token: string; refresh_token: string; expires_in?: number; id_token?: string };
type Session = { id: string; phase: LoginPhase; state: string; verifier: string; redirect: string; url: string; server: Server; controller: AbortController; timer: NodeJS.Timeout; message: string; expiresAt: number; work?: Promise<void> };
export class GoogleAccountLogin {
  private sessions = new Map<string, Session>();
  constructor(private readonly save: (token: Tokens, signal: AbortSignal) => Promise<void>, private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly timeoutMs = 600_000) {}
  async begin(): Promise<{ id: string; url: string }> {
    const clientId = getGoogleClientId(), clientSecret = getGoogleClientSecret();
    if (!clientId || !clientSecret) throw new Error(bt('oauth.err.missing_client'));
    for (const s of this.sessions.values()) {
      if (s.phase === 'saving') throw new Error(bt('oauth.err.saving_in_progress'));
      this.cancel(s.id);
    }
    while (this.sessions.size >= 8) this.sessions.delete(this.sessions.keys().next().value!);
    const server = createServer(); server.maxHeadersCount = 30; server.headersTimeout = 5000; server.requestTimeout = 10000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new Error(bt('oauth.err.callback_create_failed')); }
    const redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent select_account', state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: ['openid','https://www.googleapis.com/auth/cloud-platform','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/userinfo.profile','https://www.googleapis.com/auth/cclog','https://www.googleapis.com/auth/experimentsandconfigs'].join(' ') }).toString();
    const s: Session = { id: randomUUID(), phase: 'waiting', state, verifier, redirect, url: url.href, server, controller: new AbortController(), timer: undefined!, message: '', expiresAt: Date.now() + this.timeoutMs };
    s.timer = setTimeout(() => { if (s.phase !== 'saving') this.finish(s, 'expired', bt('oauth.err.expired')); }, this.timeoutMs); s.timer.unref();
    this.sessions.set(s.id, s);
    server.on('error', () => this.finish(s, 'failed', bt('oauth.err.callback_unavailable')));
    server.on('request', (req, res) => {
      const escapeHtml = (val: string) => val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const respond = (code: number, message: string) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Connection': 'close' }); res.end(`<!doctype html><meta charset="utf-8"><title>GravityBox</title><p>${escapeHtml(message)}</p>`); };
      let callback: URL;
      try { callback = new URL(req.url || '', redirect); } catch { respond(400, bt('oauth.http.invalid_request')); return; }
      if (req.method !== 'GET' || req.headers.host !== new URL(redirect).host || callback.pathname !== '/oauth/callback') { respond(404, bt('oauth.http.not_found')); return; }
      const returnedState = Buffer.from(callback.searchParams.get('state') || ''); const expected = Buffer.from(s.state);
      if (returnedState.length !== expected.length || !timingSafeEqual(returnedState, expected)) { respond(400, bt('oauth.http.state_mismatch')); return; }
      if (s.phase !== 'waiting') { respond(409, bt('oauth.http.already_handled')); return; }
      if (callback.searchParams.has('error')) { respond(200, bt('oauth.http.cancelled_page')); this.finish(s, 'cancelled', bt('oauth.msg.cancelled')); return; }
      const code = callback.searchParams.get('code');
      if (!code || code.length > 8192) { respond(400, bt('oauth.http.incomplete_response')); return; }
      s.phase = 'exchanging'; respond(200, bt('oauth.http.completing'));
      s.server.close();
      s.work = this.exchange(s, code);
    });
    return { id: s.id, url: s.url };
  }
  status(id: string) {
    const s = this.sessions.get(id); if (!s) throw new Error(bt('oauth.err.session_expired'));
    return { id: s.id, phase: s.phase, message: s.message, expiresAt: s.expiresAt };
  }
  cancel(id: string) {
    const s = this.sessions.get(id);
    if (s && ['waiting','exchanging'].includes(s.phase)) this.finish(s, 'cancelled', bt('oauth.msg.cancelled'));
    return this.status(id);
  }
  private finish(s: Session, phase: LoginPhase, message: string) {
    clearTimeout(s.timer); s.phase = phase; s.message = message;
    s.controller.abort(); s.server.close(); s.server.closeIdleConnections(); s.state = ''; s.verifier = ''; s.url = '';
  }
  private async exchange(s: Session, code: string) {
    try {
      const outboundFetch = resolveOutboundFetch(this.fetchImpl);
      const reply = await outboundFetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.any([s.controller.signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: getGoogleClientId(), client_secret: getGoogleClientSecret(), code, code_verifier: s.verifier, redirect_uri: s.redirect, grant_type: 'authorization_code' }).toString() });
      if (!reply.ok) throw new CodedAccountError('oauth_incomplete', bt('oauth.err.incomplete'));
      const token = await reply.json() as Tokens;
      if (!token.access_token || !token.refresh_token || typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string') throw new CodedAccountError('oauth_no_credentials', bt('oauth.err.no_credentials'));
      s.controller.signal.throwIfAborted();
      s.phase = 'saving'; clearTimeout(s.timer);
      await this.save(token, s.controller.signal);
      this.finish(s, 'succeeded', bt('oauth.msg.succeeded'));
    } catch (error) {
      if (s.controller.signal.aborted) return;
      const msg = error instanceof Error && (accountErrorCode(error) !== null || /^(Google|未取得|未能|账号|Account |Unable to |Login credentials|登录凭据|Missing |缺少|Invalid |无效)/.test(error.message)) ? error.message : bt('oauth.err.network');
      this.finish(s, 'failed', msg);
    }
  }
  async close() {
    for (const s of this.sessions.values()) if (!['succeeded','failed','cancelled','expired'].includes(s.phase)) this.finish(s, 'cancelled', bt('oauth.msg.closed'));
    await Promise.allSettled([...this.sessions.values()].map(s => s.work).filter((p): p is Promise<void> => !!p));
  }
}
