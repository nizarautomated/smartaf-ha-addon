import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import http from 'node:http';
import { SupportConsentController, CONSENT_LIMITS } from '../src/support-consent.mjs';
import { createSupportConsentHandler, createSupportConsentServer } from '../src/support-consent-server.mjs';

const user = 'a'.repeat(32), origin = 'https://home.example.test';
const ingress = '/api/hassio_ingress/' + 't'.repeat(32);
const headers = { host: 'home.example.test', 'x-hass-source': 'core.ingress', 'x-remote-user-id': user, 'x-ingress-path': ingress };
function controller() {
  return new SupportConsentController({ homeId: 'home_fixture', policy: { schema_version: 1, home_id: 'home_fixture', revision: 1, enabled: true, runtime: { permissions: [] }, telemetry: { entities: [] }, support: { enabled: true, operators: ['operator_fixture'], actions: ['read_health'], entities: [] } }, allowedOrigins: [origin], allowedConsentUsers: [user] });
}
async function exercise(handler, { method = 'GET', path = '/', requestHeaders = headers, rawHeaders, peer = '172.30.32.2', chunks = [] } = {}) {
  const request = Readable.from(chunks.map(value => Buffer.from(value)));
  Object.assign(request, { method, url: path, headers: requestHeaders, rawHeaders: rawHeaders ?? Object.entries(requestHeaders).flat(), socket: { remoteAddress: peer } });
  const result = {};
  const response = { headersSent: false, writeHead(status, values) { result.status = status; result.headers = values; this.headersSent = true; }, end(value) { result.body = value; }, destroy() { result.destroyed = true; } };
  await handler(request, response);
  return result;
}

test('HTTP adapter runs review/approve/revoke through actual request streams without a public auth bypass', async () => {
  const c = controller(); c.setTransportState({ haConnected: true, serverConnected: true, bufferedEvents: 0 });
  const handler = createSupportConsentHandler(c), page = await exercise(handler);
  assert.equal(page.status, 200);
  const cookie = page.headers['set-cookie'].split(';')[0], csrf = page.body.match(/name="support-csrf" content="([^"]+)"/)[1];
  const requestHeaders = { ...headers, cookie, origin, 'x-support-csrf': csrf, 'content-type': 'application/json' };
  const post = (path, body) => exercise(handler, { method: 'POST', path, requestHeaders, chunks: [JSON.stringify(body)] });
  const grantInput = { schema_version: 1, grant_id: 'grant_fixture', incident_id: 'incident_fixture', home_id: 'home_fixture', operator_id: 'operator_fixture', local_session_id: c.localSessionId, policy_revision: 1, actions: ['read_health'], entities: [], issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString() };
  c.receiveProposal(grantInput, { homeId: 'home_fixture', localSessionId: c.localSessionId });
  const prepared = await post('/api/prepare', { grant_id: grantInput.grant_id });
  assert.equal(prepared.status, 200);
  const approved = await post('/api/approve', { draft_id: JSON.parse(prepared.body).draft_id, confirm: true });
  assert.equal(approved.status, 200);
  const grant = JSON.parse(approved.body).grant;
  assert.equal((await post('/api/revoke', { grant_id: grant.grant_id })).status, 200);
});

test('HTTP rejects duplicate identity/security headers rather than relying on Node merge behavior', async () => {
  const handler = createSupportConsentHandler(controller());
  for (const name of ['Host', 'Origin', 'Cookie', 'Content-Length', 'X-Remote-User-Id', 'X-Ingress-Path', 'X-Support-Csrf']) {
    const result = await exercise(handler, { rawHeaders: [...Object.entries(headers).flat(), name, 'value', name.toLowerCase(), 'other'] });
    assert.equal(result.status, 400, name);
    assert.equal(JSON.parse(result.body).error, 'ambiguous_header');
  }
});

test('HTTP enforces streaming body budget and rejects compressed bodies and GET bodies', async () => {
  const handler = createSupportConsentHandler(controller());
  for (const extra of [{ 'content-length': String(CONSENT_LIMITS.bodyBytes + 1) }, { 'content-length': '-1' }, { 'content-length': '1e3' }]) {
    assert.equal((await exercise(handler, { method: 'POST', requestHeaders: { ...headers, ...extra } })).status, 413);
  }
  assert.equal((await exercise(handler, { method: 'POST', chunks: ['a'.repeat(4096), 'b'.repeat(4096), 'c'] })).status, 413);
  for (const extra of [{ 'content-encoding': 'gzip' }, { 'content-length': '1' }, { 'transfer-encoding': 'chunked' }]) {
    assert.equal((await exercise(handler, { requestHeaders: { ...headers, ...extra } })).status, 400);
  }
});

test('socket peer takes precedence over spoofed forwarding and authentication headers', async () => {
  const result = await exercise(createSupportConsentHandler(controller()), { peer: '127.0.0.1', requestHeaders: { ...headers, 'x-forwarded-for': '172.30.32.2', 'x-real-ip': '172.30.32.2' } });
  assert.equal(result.status, 403);
  assert.equal(JSON.parse(result.body).error, 'ingress_peer_required');
});

test('server has bounded parser/timeouts and does not listen as a creation side effect', async () => {
  const server = createSupportConsentServer({ controller: controller() });
  assert.equal(server.listening, false);
  assert.equal(server.headersTimeout, 5000);
  assert.equal(server.requestTimeout, 10000);
  assert.equal(server.maxHeadersCount, 32);
  assert.equal(server.maxConnections, 32);
  assert.throws(() => createSupportConsentServer({ controller: { handle() {} } }));
});

test('real TCP direct access is denied even with all valid-looking Ingress headers', async t => {
  const server = createSupportConsentServer({ controller: controller() });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) { t.skip(`Local sandbox blocks loopback listener (${error.code}); HTTP stream tests remain active`); return; }
    throw error;
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/', headers }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', reject);
    });
    assert.equal(result.status, 403); assert.equal(JSON.parse(result.body).error, 'ingress_peer_required');
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) t.skip(`Local sandbox blocks loopback connection (${error.code}); HTTP stream tests remain active`);
    else throw error;
  } finally { await new Promise(resolve => server.close(resolve)); }
});
