import test from 'node:test';
import assert from 'node:assert/strict';
import { SupportConsentController, CONSENT_LIMITS, supportGrantDigest } from '../src/support-consent.mjs';
import { SUPPORT_READ_ACTIONS } from '../src/access-policy.mjs';

const epoch = Date.parse('2026-10-19T18:00:00Z');
const user = 'a'.repeat(32), otherUser = 'b'.repeat(32);
const origin = 'https://home.example.test';
const ingressPath = '/api/hassio_ingress/' + 't'.repeat(32);
const iso = value => new Date(value).toISOString();
function policy() {
  return { schema_version: 1, home_id: 'home_fixture', revision: 7, enabled: true, runtime: { permissions: [] }, telemetry: { entities: [] }, support: { enabled: true, operators: ['operator_fixture'], actions: [...SUPPORT_READ_ACTIONS], entities: ['light.kitchen', 'binary_sensor.motion'] } };
}
function fixture({ input = policy(), users = [user], origins = [origin], online = true, display } = {}) {
  let now = epoch;
  const controller = new SupportConsentController({ homeId: 'home_fixture', policy: input, allowedOrigins: origins, allowedConsentUsers: users, display, clock: () => now });
  if (online) controller.setTransportState({ haConnected: true, serverConnected: true, bufferedEvents: 0 });
  const base = { remoteAddress: '172.30.32.2', headers: { host: 'home.example.test', 'x-remote-user-id': user, 'x-hass-source': 'core.ingress', 'x-ingress-path': ingressPath } };
  const request = (path, { method = 'GET', headers = {}, body, ...rest } = {}) => controller.handle({ ...base, method, path, headers: { ...base.headers, ...headers }, ...(body === undefined ? {} : { rawBody: JSON.stringify(body) }), ...rest });
  const page = () => {
    const result = request('/'); assert.equal(result.status, 200);
    return { cookie: result.headers['set-cookie'].split(';')[0], csrf: result.body.match(/name="support-csrf" content="([^"]+)"/)[1], result };
  };
  const post = (session, path, body, change = {}) => request(path, { method: 'POST', body, headers: { cookie: session.cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-support-csrf': session.csrf, ...(change.headers ?? {}) }, ...Object.fromEntries(Object.entries(change).filter(([key]) => key !== 'headers')) });
  let proposalIndex = 0;
  const scope = { grant_id: 'grant_fixture_pending' };
  const proposal = (change = {}) => {
    const { duration_minutes = 15, ...fields } = change;
    return { schema_version: 1, grant_id: `grant_fixture_${++proposalIndex}`, incident_id: 'incident_fixture', home_id: 'home_fixture', operator_id: 'operator_fixture', local_session_id: controller.localSessionId, policy_revision: 7, actions: ['read_entity_availability'], entities: ['light.kitchen'], issued_at: iso(now), expires_at: iso(now + duration_minutes * 60_000), ...fields };
  };
  const receive = grant => controller.receiveProposal(grant, { homeId: 'home_fixture', localSessionId: controller.localSessionId });
  const prepare = (session, change = {}) => { const grant = proposal(change); receive(grant); const result = post(session, '/api/prepare', { grant_id: grant.grant_id }); assert.equal(result.status, 200, result.body); return JSON.parse(result.body); };
  const approve = (session, draft = prepare(session)) => { const result = post(session, '/api/approve', { draft_id: draft.draft_id, confirm: true }); assert.equal(result.status, 200, result.body); return JSON.parse(result.body).grant; };
  const diagnose = (grant, change = {}) => controller.readDiagnosis({ grant_id: grant.grant_id, incident_id: grant.incident_id, home_id: grant.home_id, operator_id: grant.operator_id, local_session_id: grant.local_session_id, policy_revision: grant.policy_revision, action: 'read_entity_availability', entities: ['light.kitchen'], requested_at: iso(now), ...change }, { observed_at: iso(now), states: [{ entity_id: 'light.kitchen', state: 'on', attributes: { token: 'secret', brightness: 125 } }] }, { operatorId: 'operator_fixture' });
  return { controller, request, page, post, prepare, approve, diagnose, scope, proposal, receive, advance: value => { now += value; }, setTime: value => { now = value; } };
}
const errorCode = result => JSON.parse(result.body).error;

test('local display names cannot expand scope, identify an operator, or enter the support transport', () => {
  const display = { home_name: 'Mijn woning', entities: { 'light.kitchen': 'Keukenlamp', 'sensor.private': 'Privénaam' } };
  const f = fixture({ display }), session = f.page();
  display.entities['light.kitchen'] = 'Later gewijzigd';
  const state = JSON.parse(f.request('/api/state', { headers: { cookie: session.cookie } }).body);
  assert.deepEqual(state.display, { home_name: 'Mijn woning', entities: { 'light.kitchen': 'Keukenlamp' } });
  assert.equal(f.request('/api/state').status, 401);
  const grant = f.proposal(), digest = supportGrantDigest(grant); f.receive(grant);
  const prepared = f.post(session, '/api/prepare', { grant_id: grant.grant_id });
  const draft = JSON.parse(prepared.body);
  assert.equal(Object.hasOwn(draft, 'display'), false);
  assert.equal(f.post(session, '/api/approve', { draft_id: draft.draft_id, confirm: true, display: { entities: { 'sensor.private': 'Keukenlamp' } } }).status, 400);
  const approved = f.approve(session, draft);
  assert.equal(supportGrantDigest(approved), digest);
  const report = f.diagnose(approved), transport = f.controller.transportSnapshot();
  for (const value of [prepared.body, JSON.stringify(approved), JSON.stringify(report), JSON.stringify(transport)]) {
    assert.equal(value.includes('Keukenlamp'), false); assert.equal(value.includes('Privénaam'), false); assert.equal(value.includes('Mijn woning'), false);
  }
  assert.throws(() => f.diagnose(approved, { entities: ['sensor.private'] }), { code: 'support_scope_denied' });
  assert.equal(f.post(session, '/api/revoke', { grant_id: approved.grant_id }).status, 200);
  assert.throws(() => f.diagnose(approved), { code: 'support_grant_absent' });
  assert.throws(() => fixture({ display: { operator_name: 'Verzonnen beheerder' } }), TypeError);
});

test('local consent is disabled by default and cannot configure policy or connect transport over HTTP', () => {
  for (const options of [{ input: null }, { input: { ...policy(), support: { ...policy().support, enabled: false } } }, { online: false }]) {
    const f = fixture(options), session = f.page();
    const status = JSON.parse(f.request('/api/state', { headers: { cookie: session.cookie } }).body);
    assert.equal(status.grants.length, 0);
    const result = f.post(session, '/api/prepare', f.scope);
    assert.ok([403, 503].includes(result.status));
    for (const path of ['/api/enable', '/api/connect', '/api/diagnosis', '/approve', '/api/runtime', '/api/terminal']) assert.equal(f.post(session, path, {}).status, 404);
  }
});

test('reviewed local consent permits only bounded diagnosis and revoke stops it immediately', () => {
  const f = fixture(), session = f.page(), draft = f.prepare(session);
  assert.equal(JSON.parse(f.request('/api/state', { headers: { cookie: session.cookie } }).body).grants.length, 0);
  f.advance(10_000);
  const grant = f.approve(session, draft);
  assert.equal(grant.issued_at, iso(epoch));
  assert.equal(grant.expires_at, draft.expires_at); // Approval never extends the reviewed deadline.
  assert.equal(Date.parse(grant.expires_at) - Date.parse(grant.issued_at), 900_000);
  const report = f.diagnose(grant);
  assert.deepEqual(report.data, [{ entity_id: 'light.kitchen', availability: 'available' }]);
  assert.equal(JSON.stringify(report).includes('secret'), false);
  assert.throws(() => f.diagnose(grant, { action: 'read_incident_log' }), { code: 'support_scope_denied' });
  assert.equal(f.post(session, '/api/revoke', { grant_id: grant.grant_id }).status, 200);
  assert.throws(() => f.diagnose(grant), { code: 'support_grant_absent' });
});

test('only the actual Supervisor socket peer plus authenticated allowlisted user is trusted', () => {
  const f = fixture();
  for (const remoteAddress of ['127.0.0.1', '::1', '172.30.32.3', '8.8.8.8', '172.30.32.2:80']) {
    assert.equal(errorCode(f.request('/', { remoteAddress, headers: { 'x-forwarded-for': '172.30.32.2' } })), 'ingress_peer_required');
  }
  assert.equal(f.request('/', { remoteAddress: '::ffff:172.30.32.2' }).status, 200);
  for (const value of [undefined, '', otherUser, 'admin', [user], `${user},${otherUser}`]) assert.equal(f.request('/', { headers: { 'x-remote-user-id': value } }).status, 403);
  assert.equal(f.request('/', { headers: { 'x-hass-source': 'spoof' } }).status, 403);
  for (const path of ['', '/', '/api/hassio_ingress/../bad', `${ingressPath}?token=1`, `${ingressPath}/x`, [ingressPath]]) assert.equal(f.request('/', { headers: { 'x-ingress-path': path } }).status, 403);
});

test('Origin Host Referer Fetch Metadata and CSRF checks cannot be replaced by forwarding headers', () => {
  const f = fixture(), session = f.page();
  for (const headers of [
    { origin: undefined }, { origin: 'https://evil.example' }, { origin: 'null' }, { origin: [origin] },
    { host: 'evil.example', 'x-forwarded-host': 'home.example.test', 'x-forwarded-proto': 'https' },
    { referer: 'https://evil.example/' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { 'x-support-csrf': undefined }, { 'x-support-csrf': 'x'.repeat(43) }, { 'x-support-csrf': [session.csrf] }
  ]) assert.equal(f.post(session, '/api/prepare', f.scope, { headers }).status, 403);
  const grant = f.proposal(); f.receive(grant);
  assert.equal(f.post(session, '/api/prepare', { grant_id: grant.grant_id }, { headers: { 'sec-fetch-site': undefined } }).status, 200); // Origin + CSRF still mandatory.
});

test('sessions bind HA user, Ingress path, exact origin and absolute lifetime without renewal', () => {
  const f = fixture({ users: [user, otherUser], origins: [origin, 'https://remote.example.test'] }), session = f.page();
  assert.equal(errorCode(f.request('/api/state', { headers: { cookie: session.cookie, 'x-remote-user-id': otherUser } })), 'session_context_changed');
  assert.equal(errorCode(f.request('/api/state', { headers: { cookie: session.cookie, 'x-ingress-path': ingressPath + 'z' } })), 'session_context_changed');
  assert.equal(errorCode(f.request('/api/state', { headers: { cookie: session.cookie, host: 'remote.example.test' } })), 'session_context_changed');
  assert.equal(errorCode(f.request('/api/state', { headers: { cookie: `${session.cookie}; ${session.cookie}` } })), 'ambiguous_cookie');
  f.advance(CONSENT_LIMITS.sessionMs - 1);
  const refreshed = f.request('/', { headers: { cookie: session.cookie } });
  assert.match(refreshed.headers['set-cookie'], /Max-Age=0;/);
  f.advance(1);
  assert.equal(errorCode(f.request('/api/state', { headers: { cookie: session.cookie } })), 'session_expired');
});

test('draft is immutable single-use, tied to session, and expires at the exact boundary', () => {
  const f = fixture(), a = f.page(), b = f.page(), draft = f.prepare(a);
  assert.equal(f.post(b, '/api/approve', { draft_id: draft.draft_id, confirm: true }).status, 409);
  assert.equal(f.post(a, '/api/approve', { draft_id: draft.draft_id, confirm: false }).status, 400);
  assert.equal(f.post(a, '/api/approve', { draft_id: draft.draft_id, confirm: true, duration_minutes: 30 }).status, 400);
  f.approve(a, draft);
  assert.equal(f.post(a, '/api/approve', { draft_id: draft.draft_id, confirm: true }).status, 409);
  const expired = f.prepare(a); f.advance(CONSENT_LIMITS.draftMs);
  assert.equal(f.post(a, '/api/approve', { draft_id: expired.draft_id, confirm: true }).status, 409);
  const old = f.prepare(a); f.prepare(a);
  assert.equal(f.post(a, '/api/approve', { draft_id: old.draft_id, confirm: true }).status, 409);
});

test('scope is a strict subset; no body-supplied signature, key, actor, arbitrary action or duration', () => {
  const f = fixture(), session = f.page();
  for (const change of [
    { operator_id: 'operator_other' }, { actions: ['light.turn_on'] }, { actions: [] }, { actions: ['read_health', 'read_health'] },
    { entities: ['sensor.private'] }, { entities: [] }, { entities: ['light.kitchen', 'light.kitchen'] },
    { duration_minutes: 31 }, { duration_minutes: 0 }, { duration_minutes: '15' },
    { consentKey: 'attacker' }, { signature: 'attacker' }, { home_id: 'home_other' }, { user_id: user }
  ]) assert.ok([400, 403].includes(f.post(session, '/api/prepare', { ...f.scope, ...change }).status));
  const draft = f.prepare(session, { actions: ['read_health'], entities: [], duration_minutes: 30 });
  assert.equal(Date.parse(draft.expires_at) - epoch, 30 * 60_000);
});

test('disconnect and restart revoke grants and stale browser sessions fail closed', () => {
  for (const change of [{ haConnected: false, serverConnected: true, bufferedEvents: 1 }, { haConnected: true, serverConnected: false, bufferedEvents: 1 }]) {
    const f = fixture(), session = f.page(), grant = f.approve(session);
    f.controller.setTransportState(change);
    assert.throws(() => f.diagnose(grant), { code: 'support_offline' });
    f.controller.setTransportState({ haConnected: true, serverConnected: true, bufferedEvents: 0 });
    assert.throws(() => f.diagnose(grant), { code: 'support_grant_absent' });
    assert.equal(f.post(session, '/api/prepare', f.scope).status, 401);
    const restarted = fixture();
    assert.throws(() => restarted.diagnose(grant), { code: 'support_grant_absent' });
    assert.equal(restarted.post(session, '/api/prepare', restarted.scope).status, 401);
  }
});

test('expiry and clock rollback cannot prolong a grant; clock failure requires restart', () => {
  const f = fixture(), session = f.page(), grant = f.approve(session, f.prepare(session, { duration_minutes: 5 }));
  f.advance(300_000);
  assert.throws(() => f.diagnose(grant));
  const next = fixture(), other = next.approve(next.page());
  next.setTime(epoch - 1);
  assert.throws(() => next.diagnose(other), { code: 'clock_untrusted' });
  next.setTime(epoch + 1);
  assert.throws(() => next.controller.setTransportState({ haConnected: true, serverConnected: true, bufferedEvents: 0 }), { code: 'clock_untrusted' });
});

test('no secrets or HA identities in responses; secure cookie, CSP and bounded sessions', () => {
  const f = fixture(), session = f.page();
  assert.match(session.result.headers['set-cookie'], /HttpOnly; Secure; SameSite=Strict$/);
  assert.match(session.result.headers['set-cookie'], new RegExp(`Path=${ingressPath}/;`));
  assert.match(session.result.headers['content-security-policy'], /default-src 'none'; script-src 'nonce-/);
  assert.equal(session.result.headers['cache-control'], 'no-store');
  assert.equal(session.result.body.includes(user), false);
  const grant = f.approve(session);
  const status = f.request('/api/state', { headers: { cookie: session.cookie } });
  for (const value of [user, 'consentKey', 'signature', 'x-remote-user-id']) assert.equal(status.body.includes(value), false);
  assert.equal(JSON.parse(status.body).grants[0].grant_id, grant.grant_id);
  for (let index = 1; index < CONSENT_LIMITS.sessions; index++) f.page();
  assert.equal(f.request('/').status, 429);
});

test('malformed JSON, oversized payloads, wrong media types and method confusion are rejected', () => {
  const f = fixture(), session = f.page();
  assert.equal(f.post(session, '/api/prepare', f.scope, { rawBody: '{' }).status, 400);
  assert.equal(f.post(session, '/api/prepare', f.scope, { rawBody: 'x'.repeat(CONSENT_LIMITS.bodyBytes + 1) }).status, 413);
  assert.equal(f.post(session, '/api/prepare', f.scope, { headers: { 'content-type': 'text/plain' } }).status, 415);
  for (const method of ['PUT', 'DELETE', 'OPTIONS', 'HEAD']) assert.equal(f.request('/api/approve', { method }).status, 405);
  assert.equal(f.request('/api/approve', { headers: { cookie: session.cookie } }).status, 405);
  assert.equal(f.request('/api/state?anything=1', { headers: { cookie: session.cookie } }).status, 404);
});

test('consent configuration requires explicit HTTPS origins and local user allowlist', () => {
  for (const origins of [[], ['http://home.example.test'], [origin + '/'], ['https://user:pass@home.example.test'], [origin, origin]]) assert.throws(() => fixture({ origins }));
  for (const users of [[], ['admin'], [user, user]]) assert.throws(() => fixture({ users }));
});

test('central proposals cannot add privileges, cross home/session/revision or change after receipt', () => {
  const f = fixture();
  for (const change of [
    { home_id: 'home_other' }, { local_session_id: 'session_fake' }, { policy_revision: 8 },
    { operator_id: 'operator_other' }, { actions: ['read_health', 'arbitrary_command'] }, { actions: [] },
    { entities: ['sensor.private'] }, { entities: [] }, { entities: ['light.kitchen', 'light.kitchen'] },
    { duration_minutes: 30.1 }, { duration_minutes: 0 }, { issued_at: iso(epoch + 1) },
    { grant_id: ['grant_not_string'] }, { incident_id: ['incident_not_string'] }, { signature: 'remote_approval' }
  ]) assert.throws(() => f.receive(f.proposal(change)));
  const grant = f.proposal();
  assert.throws(() => f.controller.receiveProposal(grant, { homeId: 'home_other', localSessionId: f.controller.localSessionId }), { code: 'proposal_transport_mismatch' });
  assert.deepEqual(f.receive(grant), { received: true, grant_id: grant.grant_id, duplicate: false });
  assert.equal(f.receive(grant).duplicate, true);
  assert.throws(() => f.receive({ ...grant, expires_at: iso(epoch + 1_000) }), { code: 'proposal_changed' });
  assert.throws(() => f.receive({ ...grant, entities: ['binary_sensor.motion'] }), { code: 'proposal_changed' });
  grant.entities[0] = 'sensor.private';
  const session = f.page(), shown = JSON.parse(f.request('/api/state', { headers: { cookie: session.cookie } }).body);
  assert.deepEqual(shown.proposals[0].entities, ['light.kitchen']);
  assert.deepEqual(f.controller.transportSnapshot().approvals, []);
});

test('declining a proposal and central revocation invalidate reviewed copies across all local sessions', () => {
  const f = fixture(), a = f.page(), b = f.page(), draft = f.prepare(a);
  assert.equal(f.post(b, '/api/revoke', { grant_id: draft.grant_id }).status, 200);
  assert.equal(f.post(a, '/api/approve', { draft_id: draft.draft_id, confirm: true }).status, 409);
  const fresh = f.prepare(a), grant = f.approve(a, fresh);
  assert.deepEqual(f.controller.transportSnapshot().approvals, [{ approved: true, grant_id: grant.grant_id, local_session_id: grant.local_session_id, expires_at: grant.expires_at }]);
  f.controller.receiveRevocation(grant.grant_id, { homeId: grant.home_id, localSessionId: grant.local_session_id });
  assert.throws(() => f.diagnose(grant), { code: 'support_grant_absent' });
  assert.equal(f.receive(grant).duplicate, true); // Replay cannot resurrect a revoked proposal.
  const status = JSON.parse(f.request('/api/state', { headers: { cookie: a.cookie } }).body);
  assert.equal(status.proposals.length, 0); assert.equal(status.grants.length, 0);
  assert.ok(f.controller.transportSnapshot().revoked_grant_ids.includes(grant.grant_id));
});
