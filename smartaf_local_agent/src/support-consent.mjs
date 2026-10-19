import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { compileAccessPolicy, LocalSupportAccess, signLocalSupportApproval, SUPPORT_LIMITS } from './access-policy.mjs';
import { renderSupportConsentPage } from './support-consent-ui.mjs';

export const CONSENT_LIMITS = Object.freeze({ bodyBytes: 8_192, sessions: 16, sessionMs: 10 * 60_000, draftMs: 60_000 });
const USER = /^[a-f0-9]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PATH = /^\/api\/hassio_ingress\/[A-Za-z0-9_-]{16,256}\/?$/;
const ID = /^[a-z][a-z0-9_-]{2,95}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const stamp = value => typeof value === 'string' && ISO.test(value) ? Date.parse(value) : NaN;
const GRANT_KEYS = ['schema_version', 'home_id', 'grant_id', 'incident_id', 'operator_id', 'local_session_id', 'policy_revision', 'actions', 'entities', 'issued_at', 'expires_at'];
const TRUSTED_PEERS = new Set(['172.30.32.2', '::ffff:172.30.32.2']);
const token = () => randomBytes(32).toString('base64url');
const iso = value => new Date(value).toISOString();
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, names) => plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && TOKEN.test(left) && TOKEN.test(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const copy = value => structuredClone(value);
const canonicalGrant = value => Array.isArray(value) ? `[${value.map(canonicalGrant).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalGrant(value[key])}`).join(',')}}` : JSON.stringify(value);
export const supportGrantDigest = grant => createHash('sha256').update(canonicalGrant(grant)).digest('hex');

class ConsentError extends Error {
  constructor(code, status = 403) { super(code); this.code = code; this.status = status; }
}
const deny = (code, status) => { throw new ConsentError(code, status); };

// The HTTP adapter must provide the actual socket peer. Forwarding headers are
// never a substitute. No peer override or development bypass exists here.
export function verifyConsentIngress({ remoteAddress, headers = {} }, allowedOrigins, allowedUsers) {
  if (!TRUSTED_PEERS.has(remoteAddress)) deny('ingress_peer_required');
  for (const name of ['host', 'origin', 'referer', 'cookie', 'x-hass-source', 'x-ingress-path', 'x-remote-user-id', 'x-support-csrf', 'sec-fetch-site']) {
    if (headers[name] !== undefined && typeof headers[name] !== 'string') deny('ambiguous_header');
  }
  const path = headers['x-ingress-path'];
  if (headers['x-hass-source'] !== 'core.ingress' || typeof path !== 'string' || !PATH.test(path)) deny('ingress_context_required');
  const user = headers['x-remote-user-id'];
  if (typeof user !== 'string' || !USER.test(user) || !allowedUsers.includes(user)) deny('local_user_not_authorized');
  const matching = allowedOrigins.filter(value => new URL(value).host === headers.host);
  if (matching.length !== 1) deny('origin_not_authorized');
  const origin = matching[0];
  if (headers.origin !== undefined && headers.origin !== origin) deny('origin_not_authorized');
  if (headers.referer !== undefined) {
    try { if (new URL(headers.referer).origin !== origin) deny('origin_not_authorized'); }
    catch { deny('origin_not_authorized'); }
  }
  if (headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(headers['sec-fetch-site'])) deny('cross_site_request');
  return { user, origin, path: path.replace(/\/$/, '') };
}

export class SupportConsentController {
  #homeId; #policy; #clock; #lastNow; #clockFailed = false;
  #origins; #users; #key = randomBytes(32); #access; #online = false;
  #sessions = new Map(); #grants = new Map(); #proposals = new Map(); #seenProposals = new Map(); #revoked = new Set(); #cookieName;

  constructor({ homeId, policy = null, allowedOrigins = [], allowedConsentUsers = [], clock = Date.now } = {}) {
    this.#policy = compileAccessPolicy(policy, { homeId });
    if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.length > 8 || new Set(allowedOrigins).size !== allowedOrigins.length) throw new TypeError('Explicit local HTTPS origins required');
    this.#origins = allowedOrigins.map(value => {
      let parsed; try { parsed = new URL(value); } catch { throw new TypeError('Invalid consent origin'); }
      if (typeof value !== 'string' || parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password) throw new TypeError('Exact HTTPS origins required');
      return value;
    });
    if (!Array.isArray(allowedConsentUsers) || !allowedConsentUsers.length || allowedConsentUsers.length > 20 || new Set(allowedConsentUsers).size !== allowedConsentUsers.length || !allowedConsentUsers.every(value => typeof value === 'string' && USER.test(value))) throw new TypeError('Explicit local HA user allowlist required');
    if (typeof clock !== 'function') throw new TypeError('Invalid clock');
    this.#homeId = homeId; this.#users = [...allowedConsentUsers]; this.#clock = clock;
    this.#lastNow = clock();
    if (!Number.isSafeInteger(this.#lastNow) || this.#lastNow < 0) throw new TypeError('Invalid clock');
    this.#cookieName = `smartaf_consent_${createHash('sha256').update(homeId).digest('hex').slice(0, 16)}`;
    this.#access = new LocalSupportAccess({ homeId, policy: this.#policy, consentKey: this.#key, clock: () => this.#now() });
  }

  #now() {
    const now = this.#clock();
    if (this.#clockFailed || !Number.isSafeInteger(now) || now < this.#lastNow) {
      this.#clockFailed = true; this.#offline(); deny('clock_untrusted', 503);
    }
    this.#lastNow = now; return now;
  }
  #offline() {
    this.#online = false; this.#access.setOnline(false);
    this.#sessions.clear(); this.#grants.clear(); this.#proposals.clear(); this.#seenProposals.clear(); this.#revoked.clear();
  }

  get localSessionId() { return this.#access.sessionId; }

  // Explicit internal rotation also covers a lost first exchange response:
  // the server may know this epoch even if this controller never became online.
  resetTransportSession() {
    this.#offline(); this.#now(); this.#key = randomBytes(32);
    this.#access = new LocalSupportAccess({ homeId: this.#homeId, policy: this.#policy, consentKey: this.#key, clock: () => this.#now() });
  }

  // Internal integration hook only: never an HTTP action or server-supplied
  // approval. The agent must call this immediately on either transport loss.
  setTransportState({ haConnected, serverConnected, bufferedEvents } = {}) {
    this.#now();
    if (typeof haConnected !== 'boolean' || typeof serverConnected !== 'boolean' || !Number.isSafeInteger(bufferedEvents) || bufferedEvents < 0) {
      this.#offline(); throw new TypeError('Invalid local transport state');
    }
    const online = haConnected && serverConnected && bufferedEvents === 0;
    if (!online) { this.#offline(); return; }
    this.#online = true; this.#access.setOnline(true);
  }

  // No HTTP diagnostics endpoint. A future authenticated, home/operator-bound
  // transport may call this. Its verified actor must not come from request JSON.
  readDiagnosis(request, supplied, { operatorId } = {}) {
    this.#now(); return this.#access.readDiagnosis(request, supplied, { operatorId });
  }
  assertReadAuthorized(request, { operatorId } = {}) {
    this.#now(); return this.#access.authorizeRequest(request, { operatorId });
  }

  // The future authenticated agent transport supplies an existing central
  // pending grant. This cannot approve anything and has no HTTP route.
  receiveProposal(grant, { homeId, localSessionId } = {}) {
    const now = this.#now(); this.#sweep(now); this.#requireEnabled();
    if (homeId !== this.#homeId || localSessionId !== this.#access.sessionId) deny('proposal_transport_mismatch');
    if (!exact(grant, GRANT_KEYS) || Buffer.byteLength(JSON.stringify(grant)) > CONSENT_LIMITS.bodyBytes) deny('invalid_proposal');
    const support = this.#policy.support;
    if (grant.schema_version !== 1 || grant.home_id !== this.#homeId || grant.local_session_id !== this.#access.sessionId || grant.policy_revision !== this.#policy.revision || typeof grant.grant_id !== 'string' || !ID.test(grant.grant_id) || typeof grant.incident_id !== 'string' || !ID.test(grant.incident_id) || !support.operators.includes(grant.operator_id)) deny('invalid_proposal');
    for (const [field, max] of [['actions', 4], ['entities', SUPPORT_LIMITS.entities]]) {
      const values = grant[field];
      if (!Array.isArray(values) || values.length > max || new Set(values).size !== values.length || values.some(value => typeof value !== 'string' || !support[field].includes(value))) deny('scope_denied');
    }
    if (!grant.actions.length || (grant.actions.some(action => action !== 'read_health') && !grant.entities.length)) deny('scope_denied');
    const issued = stamp(grant.issued_at), expires = stamp(grant.expires_at);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now || expires <= issued || expires - issued > SUPPORT_LIMITS.grantMs) deny('proposal_expired');
    // Fixed field order permits idempotent transport replay without accepting
    // any alteration of an already seen id, including scope order or deadline.
    const normalized = Object.fromEntries(GRANT_KEYS.map(key => [key, grant[key]])), serialized = JSON.stringify(normalized);
    const prior = this.#seenProposals.get(grant.grant_id);
    if (prior !== undefined) {
      if (prior !== serialized) deny('proposal_changed');
      return { received: true, grant_id: grant.grant_id, duplicate: true };
    }
    if (this.#seenProposals.size >= SUPPORT_LIMITS.grantsPerSession) deny('proposal_budget_exhausted', 429);
    this.#seenProposals.set(grant.grant_id, serialized); this.#proposals.set(grant.grant_id, copy(normalized));
    return { received: true, grant_id: grant.grant_id, duplicate: false };
  }

  receiveRevocation(grantId, { homeId, localSessionId } = {}) {
    this.#now();
    if (homeId !== this.#homeId || localSessionId !== this.#access.sessionId || !this.#seenProposals.has(grantId)) deny('proposal_transport_mismatch');
    return this.#revoke(grantId);
  }

  // Reconciliation snapshot for a future adapter. It contains no local key,
  // signature, browser session, CSRF token or HA user identity. Transport must
  // re-read before delivery and must never replay across localSessionId changes.
  transportSnapshot() {
    const now = this.#now(); this.#sweep(now);
    return { local_session_id: this.#access.sessionId, online: this.#online,
      approvals: [...this.#grants.values()].map(grant => ({ approved: true, grant_id: grant.grant_id, local_session_id: grant.local_session_id, expires_at: grant.expires_at })),
      approval_proofs: [...this.#grants.values()].map(grant => ({ approval: { approved: true, grant_id: grant.grant_id, local_session_id: grant.local_session_id, expires_at: grant.expires_at }, grant_sha256: supportGrantDigest(grant) })),
      revoked_grant_ids: [...this.#revoked] };
  }

  #revoke(grantId) {
    const result = this.#access.revoke(grantId);
    this.#grants.delete(grantId); this.#proposals.delete(grantId); this.#revoked.add(grantId);
    return result;
  }

  #sweep(now) {
    for (const [id, session] of this.#sessions) if (session.expires <= now) this.#sessions.delete(id);
    for (const [id, grant] of this.#grants) if (Date.parse(grant.expires_at) <= now) this.#grants.delete(id);
    for (const [id, grant] of this.#proposals) if (Date.parse(grant.expires_at) <= now) this.#proposals.delete(id);
  }
  #cookie(headers) {
    const cookies = (headers.cookie ?? '').split(';').map(value => value.trim()).filter(Boolean);
    const found = cookies.filter(value => value.split('=', 1)[0] === this.#cookieName);
    if (found.length > 1) deny('ambiguous_cookie');
    if (!found.length) return null;
    const value = found[0].slice(this.#cookieName.length + 1);
    if (!TOKEN.test(value)) deny('invalid_session');
    return value;
  }
  #session(headers, identity, now, create = false) {
    let id = this.#cookie(headers), session = id && this.#sessions.get(id);
    if (session && (session.user !== identity.user || session.origin !== identity.origin || session.path !== identity.path || session.accessSession !== this.#access.sessionId)) deny('session_context_changed');
    if (!session && create) {
      if (this.#sessions.size >= CONSENT_LIMITS.sessions) deny('session_budget_exhausted', 429);
      id = token(); session = { ...identity, csrf: token(), expires: now + CONSENT_LIMITS.sessionMs, accessSession: this.#access.sessionId, draft: null };
      this.#sessions.set(id, session);
    }
    if (!session) deny('session_expired', 401);
    return { id, session };
  }
  #status(now) {
    return {
      enabled: this.#policy?.enabled === true && this.#policy?.support.enabled === true,
      connected: this.#online, policy_revision: this.#policy?.revision ?? null,
      maximum_minutes: SUPPORT_LIMITS.grantMs / 60_000, maximum_entities: SUPPORT_LIMITS.entities,
      server_time: iso(now), operators: [...(this.#policy?.support.operators ?? [])],
      actions: [...(this.#policy?.support.actions ?? [])], entities: [...(this.#policy?.support.entities ?? [])],
      proposals: [...this.#proposals.values()].map(copy), grants: [...this.#grants.values()].map(copy)
    };
  }
  #requireEnabled() {
    if (!this.#policy?.enabled || !this.#policy?.support.enabled) deny('support_disabled');
    if (!this.#online) deny('support_transport_unavailable', 503);
  }
  #body(rawBody, headers) {
    if (headers['content-type'] !== 'application/json') deny('json_required', 415);
    if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody) > CONSENT_LIMITS.bodyBytes) deny('body_too_large', 413);
    try { return JSON.parse(rawBody); } catch { deny('invalid_json', 400); }
  }
  #prepare(body, session, now) {
    this.#requireEnabled();
    if (!exact(body, ['grant_id']) || typeof body.grant_id !== 'string') deny('invalid_scope', 400);
    const grant = this.#proposals.get(body.grant_id);
    if (!grant) deny('proposal_required', 409);
    const draft = {
      draft_id: token(), expires: now + CONSENT_LIMITS.draftMs,
      grant: copy(grant)
    };
    session.draft = draft;
    return { draft_id: draft.draft_id, ...copy(grant), review_expires_at: iso(Math.min(draft.expires, Date.parse(grant.expires_at))) };
  }
  #approve(body, session, now) {
    this.#requireEnabled();
    if (!exact(body, ['draft_id', 'confirm']) || body.confirm !== true) deny('explicit_confirmation_required', 400);
    const draft = session.draft;
    if (!draft || !equal(body.draft_id, draft.draft_id) || draft.expires <= now || !this.#proposals.has(draft.grant.grant_id) || stamp(draft.grant.expires_at) <= now) deny('review_expired', 409);
    session.draft = null; // A reviewed scope is single use, including on failure.
    const grant = copy(draft.grant);
    this.#access.approveGrant(grant, { signature: signLocalSupportApproval(grant, { consentKey: this.#key }) });
    this.#grants.set(grant.grant_id, grant); this.#proposals.delete(grant.grant_id);
    return { approved: true, grant: copy(grant) };
  }

  handle({ method, path, headers = {}, remoteAddress, rawBody = '' } = {}) {
    const responseHeaders = {
      'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
    };
    try {
      const now = this.#now(); this.#sweep(now);
      const identity = verifyConsentIngress({ remoteAddress, headers }, this.#origins, this.#users);
      if (!['GET', 'POST'].includes(method)) deny('method_not_allowed', 405);
      if (!['/', '/api/state', '/api/prepare', '/api/approve', '/api/revoke'].includes(path)) deny('not_found', 404);
      if (method === 'GET' && path === '/') {
        const { id, session } = this.#session(headers, identity, now, true), nonce = token();
        responseHeaders['set-cookie'] = `${this.#cookieName}=${id}; Path=${identity.path}/; Max-Age=${Math.max(0, Math.floor((session.expires - now) / 1_000))}; HttpOnly; Secure; SameSite=Strict`;
        responseHeaders['content-type'] = 'text/html; charset=utf-8';
        responseHeaders['content-security-policy'] = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${identity.origin}`;
        return { status: 200, headers: responseHeaders, body: renderSupportConsentPage({ nonce, csrf: session.csrf, basePath: identity.path }) };
      }
      const { session } = this.#session(headers, identity, now);
      if (method === 'GET' && path === '/api/state') return { status: 200, headers: responseHeaders, body: JSON.stringify(this.#status(now)) };
      if (method !== 'POST' || path === '/' || path === '/api/state') deny('method_not_allowed', 405);
      if (headers.origin !== session.origin || (headers['sec-fetch-site'] !== undefined && headers['sec-fetch-site'] !== 'same-origin')) deny('same_origin_required');
      if (!equal(headers['x-support-csrf'], session.csrf)) deny('csrf_required');
      const body = this.#body(rawBody, headers);
      let result;
      if (path === '/api/prepare') result = this.#prepare(body, session, now);
      if (path === '/api/approve') result = this.#approve(body, session, now);
      if (path === '/api/revoke') {
        if (!exact(body, ['grant_id']) || typeof body.grant_id !== 'string' || (!this.#grants.has(body.grant_id) && !this.#proposals.has(body.grant_id))) deny('grant_not_found', 404);
        result = this.#revoke(body.grant_id);
      }
      return { status: 200, headers: responseHeaders, body: JSON.stringify(result) };
    } catch (error) {
      // No raw exception messages, request data, user identities or credentials.
      const code = error instanceof ConsentError || error?.name === 'LocalAccessError' ? error.code : 'consent_internal_error';
      return { status: error instanceof ConsentError ? error.status : error?.name === 'LocalAccessError' ? 403 : 500, headers: responseHeaders, body: JSON.stringify({ error: code }) };
    }
  }
}
