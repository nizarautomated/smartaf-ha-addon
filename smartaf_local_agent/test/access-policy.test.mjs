import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRuntimeCommand, compileAccessPolicy, LocalSupportAccess, selectTelemetry, signLocalSupportApproval, SUPPORT_READ_ACTIONS } from '../src/access-policy.mjs';

const homeId = 'home_alpha', operatorId = 'operator_owner';
const epoch = Date.parse('2026-10-19T15:00:00Z');
const iso = value => new Date(value).toISOString();
const consentKey = 'local-consent-key-not-shared-with-server-32bytes';
function configuration() {
  return {
    schema_version: 1, home_id: homeId, revision: 3, enabled: true,
    runtime: { permissions: [
      { entity_id: 'light.kitchen', service: 'light.turn_on', parameters: { brightness_pct: { type: 'number', min: 10, max: 80 }, brightness: { type: 'number', min: 0, max: 255 } }, required: ['brightness_pct'] },
      { entity_id: 'light.kitchen', service: 'light.turn_off', parameters: {}, required: [] }
    ] },
    telemetry: { entities: ['light.kitchen', 'binary_sensor.motion', 'sun.sun'] },
    support: { enabled: true, operators: [operatorId], entities: ['light.kitchen', 'binary_sensor.motion'], actions: [...SUPPORT_READ_ACTIONS] }
  };
}
function fixture() {
  let now = epoch;
  const policy = compileAccessPolicy(configuration(), { homeId });
  const access = new LocalSupportAccess({ homeId, policy, consentKey, clock: () => now });
  access.setOnline(true);
  const grant = {
    schema_version: 1, grant_id: 'grant_incident_001', incident_id: 'incident_001', home_id: homeId,
    operator_id: operatorId, local_session_id: access.sessionId, policy_revision: 3,
    actions: [...SUPPORT_READ_ACTIONS], entities: ['light.kitchen', 'binary_sensor.motion'],
    issued_at: iso(now), expires_at: iso(now + 30 * 60_000)
  };
  const approve = (value = grant) => access.approveGrant(value, { signature: signLocalSupportApproval(value, { consentKey }) });
  const request = (change = {}) => ({ grant_id: grant.grant_id, incident_id: grant.incident_id, home_id: homeId, operator_id: operatorId, local_session_id: access.sessionId, policy_revision: 3, action: 'read_entity_availability', entities: ['light.kitchen'], requested_at: iso(now), ...change });
  return { policy, access, grant, approve, request, advance: ms => { now += ms; }, setTime: time => { now = time; } };
}
function runtimeOptions(policy = compileAccessPolicy(configuration(), { homeId }), metadata = {}) {
  return { policy, homeId, now: epoch, entityMetadata: new Map([['light.kitchen', { entity_id: 'light.kitchen', registry_present: true, platform: 'zha', disabled: false, is_group: false, members: [], ...metadata }]]) };
}
function command(change = {}) { return { home_id: homeId, policy_revision: 3, entity_id: 'light.kitchen', service: 'light.turn_on', data: { brightness_pct: 40 }, not_before: iso(epoch - 1_000), expires_at: iso(epoch + 1_000), ...change }; }
function event(change = {}) { return { protocol_version: 1, home_id: homeId, agent_id: 'agent_alpha', event_id: 'evt_1234567', sequence: 1, occurred_at: iso(epoch), type: 'state_changed', entity_id: 'light.kitchen', old_state: 'off', new_state: 'on', ...change }; }
const rejects = (fn, code) => assert.throws(fn, code ? { code } : undefined);

test('optional policy preserves runtime compatibility but support remains denied', () => {
  assert.equal(compileAccessPolicy(undefined, { homeId }), null);
  assert.equal(authorizeRuntimeCommand(command(), runtimeOptions(null)).mode, 'legacy');
  assert.equal(selectTelemetry(event(), { policy: null, homeId }).entity_id, 'light.kitchen');
  const access = new LocalSupportAccess({ homeId });
  rejects(() => access.authorizeRequest({}, { operatorId }), 'support_disabled');
  for (const extra of [{ access_scope: 'support' }, { grant_id: 'grant_a' }, { support_grant: {} }]) rejects(() => authorizeRuntimeCommand(command(extra), runtimeOptions(null)), 'runtime_support_separation');
});

test('explicit disabled policy closes execution, telemetry and support instead of expanding rights', () => {
  const input = configuration(); input.enabled = false; input.support.enabled = false;
  const policy = compileAccessPolicy(input, { homeId });
  assert.ok(policy);
  rejects(() => authorizeRuntimeCommand(command(), runtimeOptions(policy)), 'runtime_policy_disabled');
  assert.equal(selectTelemetry(event(), { policy, homeId }), null);
  rejects(() => new LocalSupportAccess({ homeId, policy }).authorizeRequest({}, { operatorId }), 'support_disabled');
  input.support.enabled = true;
  rejects(() => compileAccessPolicy(input, { homeId }), 'support_requires_strict_policy');
});

test('compiled policies are immutable and cannot be replaced by a frozen lookalike', () => {
  const input = configuration(), policy = compileAccessPolicy(input, { homeId });
  input.runtime.permissions[0].parameters.brightness_pct.max = 100;
  assert.equal(policy.runtime.permissions[0].parameters.brightness_pct.max, 80);
  assert.throws(() => { policy.enabled = false; }, TypeError);
  rejects(() => authorizeRuntimeCommand(command(), runtimeOptions(Object.freeze(configuration()))), 'invalid_access_policy');
  rejects(() => compileAccessPolicy(configuration(), { homeId: 'home_other' }), 'invalid_access_policy');
});

test('strict runtime requires exact home, target, service, revision, deadline and bounded parameters', () => {
  const options = runtimeOptions();
  assert.equal(authorizeRuntimeCommand(command(), options).mode, 'strict');
  for (const patch of [{ home_id: 'home_other' }, { policy_revision: 2 }, { policy_revision: undefined }, { entity_id: 'light.private' }, { service: 'light.toggle' }, { service: 'script.turn_on' }, { expires_at: iso(epoch) }, { not_before: iso(epoch + 1) }]) rejects(() => authorizeRuntimeCommand(command(patch), options));
  for (const data of [{}, { brightness_pct: 81 }, { brightness_pct: -1 }, { brightness_pct: '40' }, { brightness_pct: NaN }, { brightness_pct: 40, brightness: 1.5 }, { brightness_pct: 40, entity_id: 'light.private' }, { brightness_pct: 40, area_id: 'all' }, { brightness_pct: 40, target: {} }, { brightness_pct: 40, template: '{{states}}' }, { brightness_pct: 40, toString: 'attack' }]) rejects(() => authorizeRuntimeCommand(command({ data }), options));
  rejects(() => authorizeRuntimeCommand(command({ guard: { entity_id: 'binary_sensor.private' } }), options), 'runtime_guard_entity_denied');
  assert.equal(authorizeRuntimeCommand(command({ guard: { entity_id: 'binary_sensor.motion' } }), options).mode, 'strict');
});

test('registry and direct-platform checks deny all known indirect targets and incomplete metadata', () => {
  for (const patch of [{ registry_present: false }, { disabled: true }, { is_group: true }, { members: ['light.private'] }, { members: undefined }, { entity_id: 'light.private' }, ...['group', 'template', 'universal', 'switch_as_x', 'mqtt', 'unknown', 'doorbird'].map(platform => ({ platform }))]) rejects(() => authorizeRuntimeCommand(command(), runtimeOptions(undefined, patch)), 'runtime_target_not_direct');
  rejects(() => authorizeRuntimeCommand(command(), { ...runtimeOptions(), entityMetadata: new Map() }), 'runtime_target_not_direct');
});

test('policy cannot authorize wildcards, scenes, scripts, arbitrary parameters or wider ranges', () => {
  for (const [entity, service] of [['light.*', 'light.turn_on'], ['scene.evening', 'scene.turn_on'], ['group.all', 'group.turn_on'], ['script.escape', 'script.turn_on'], ['light.kitchen', 'homeassistant.turn_on'], ['switch.kitchen', 'light.turn_on']]) {
    const input = configuration(); Object.assign(input.runtime.permissions[0], { entity_id: entity, service });
    rejects(() => compileAccessPolicy(input, { homeId }));
  }
  for (const parameter of ['entity_id', 'area_id', 'floor_id', 'device_id', 'context', 'variables', '__proto__', 'toString']) {
    const input = configuration(); input.runtime.permissions[0].parameters = JSON.parse(`{"${parameter}":{"type":"number","min":0,"max":1}}`); input.runtime.permissions[0].required = [];
    rejects(() => compileAccessPolicy(input, { homeId }));
  }
  const input = configuration(); input.runtime.permissions[0].parameters.brightness_pct.max = 101;
  rejects(() => compileAccessPolicy(input, { homeId }), 'unsafe_runtime_parameter');
  rejects(() => compileAccessPolicy({ ...configuration(), path: '/config/secrets.yaml' }, { homeId }), 'invalid_access_policy');
  const recursive = {}; recursive.self = recursive;
  rejects(() => compileAccessPolicy(recursive, { homeId }), 'input_too_large');
});

test('telemetry retains bound states and explicit timing metadata only; HA user IDs never imply manual origin', () => {
  const { policy } = fixture();
  const result = selectTelemetry(event({ context: { user_id: 'SECRET_USER' }, attributes: { latitude: 52 }, metadata: { last_changed: iso(epoch), restored: false, access_token: 'SECRET', solar: { next_rising: iso(epoch + 1_000) } } }), { policy, homeId });
  assert.equal(result.origin, 'unknown');
  assert.deepEqual(result.metadata, { last_changed: iso(epoch), restored: false });
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(selectTelemetry(event({ entity_id: 'device_tracker.private' }), { policy, homeId }), null);
  const snapshot = selectTelemetry(event({ type: 'state_snapshot', payload: { states: [{ entity_id: 'light.kitchen', state: 'on', attributes: { secret: 'SECRET' } }, { entity_id: 'device_tracker.private', state: 'LOCATION' }, { entity_id: 'sun.sun', state: 'above_horizon', metadata: { solar: { next_rising: iso(epoch + 1_000), next_setting: iso(epoch + 2_000), secret: 'SECRET' }, restored: false } }] } }), { policy, homeId });
  assert.deepEqual(snapshot.payload.states.map(item => item.entity_id), ['light.kitchen', 'sun.sun']);
  assert.deepEqual(snapshot.payload.states[1].metadata.solar, { next_rising: iso(epoch + 1_000), next_setting: iso(epoch + 2_000) });
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  rejects(() => selectTelemetry(event({ home_id: 'home_other' }), { policy, homeId }), 'wrong_home');
  rejects(() => selectTelemetry(event({ type: 'state_snapshot', payload: { states: Array.from({ length: 2 }, () => ({ entity_id: 'light.kitchen', state: 'on' })) } }), { policy, homeId }), 'invalid_telemetry');
  const call = selectTelemetry(event({ type: 'event', event_type: 'call_service', payload: { service: 'light.turn_on', entity_ids: ['light.kitchen', 'light.private'], service_data: { secret: 'SECRET' } } }), { policy, homeId });
  assert.deepEqual(call.payload, { service: 'light.turn_on', entity_ids: ['light.kitchen'] });
});

test('local approval needs a local-only signature over the full exact grant', () => {
  const f = fixture();
  rejects(() => f.access.approveGrant(f.grant), 'local_consent_required');
  const signature = signLocalSupportApproval(f.grant, { consentKey });
  rejects(() => f.access.approveGrant({ ...f.grant, expires_at: iso(epoch + 1_000) }, { signature }), 'local_consent_required');
  rejects(() => f.access.approveGrant(f.grant, { signature: '0'.repeat(64) }), 'local_consent_required');
  assert.equal(f.approve().approved, true);
  rejects(() => f.approve(), 'support_grant_reused');
  assert.equal(f.access.authorizeRequest(f.request(), { operatorId }).home_id, homeId);
});

test('grant scope cannot add a home, operator, entity, arbitrary action, path or overlong lifetime', () => {
  for (const patch of [{ home_id: 'home_other' }, { operator_id: 'operator_other' }, { entities: ['light.private'] }, { entities: ['light.*'] }, { actions: ['read_file'] }, { actions: ['call_service'] }, { path: '/config/secrets.yaml' }, { expires_at: iso(epoch + 30 * 60_000 + 1) }, { issued_at: iso(epoch + 1) }, { policy_revision: 4 }]) {
    const f = fixture(); rejects(() => f.approve({ ...f.grant, ...patch }));
  }
  const f = fixture();
  rejects(() => f.approve({ ...f.grant, entities: Array.from({ length: 11 }, (_, index) => `light.room_${index}`) }), 'invalid_support_grant');
});

test('requests bind authenticated operator, incident, home, exact entities and fixed read action', () => {
  const f = fixture(); f.approve();
  rejects(() => f.access.authorizeRequest(f.request(), { operatorId: 'operator_other' }), 'support_operator_denied');
  for (const patch of [{ home_id: 'home_other' }, { operator_id: 'operator_other' }, { incident_id: 'incident_other' }, { policy_revision: 2 }, { local_session_id: 'session_other' }, { action: 'call_service' }, { entities: ['light.private'] }, { entities: [] }, { path: '/config/secrets.yaml' }, { url: 'http://localhost:8123/api/config' }, { requested_at: iso(epoch + 1) }]) rejects(() => f.access.authorizeRequest(f.request(patch), { operatorId }));
  rejects(() => f.access.authorizeRequest(f.request({ path: 'x'.repeat(9_000) }), { operatorId }), 'input_too_large');
  f.advance(60_001);
  rejects(() => f.access.authorizeRequest(f.request({ requested_at: iso(epoch) }), { operatorId }), 'support_request_stale');
});

test('revocation, expiry, offline and agent restart invalidate queued work', () => {
  const f = fixture(); f.approve(); const queued = f.request();
  f.access.authorizeRequest(queued, { operatorId });
  f.access.revoke(f.grant.grant_id);
  rejects(() => f.access.authorizeRequest(queued, { operatorId }), 'support_grant_absent');
  rejects(() => f.approve(), 'support_grant_reused');
  const offline = fixture(); offline.approve(); const oldRequest = offline.request(), oldSession = offline.access.sessionId;
  offline.access.setOnline(false);
  rejects(() => offline.access.authorizeRequest(oldRequest, { operatorId }), 'support_offline');
  offline.access.setOnline(true);
  assert.notEqual(offline.access.sessionId, oldSession);
  rejects(() => offline.access.authorizeRequest(oldRequest, { operatorId }), 'support_grant_absent');
  rejects(() => offline.approve(), 'invalid_support_grant');
  const restarted = new LocalSupportAccess({ homeId, policy: offline.policy, consentKey, clock: () => epoch });
  rejects(() => restarted.authorizeRequest(oldRequest, { operatorId }), 'support_offline');
  restarted.setOnline(true);
  rejects(() => restarted.authorizeRequest(oldRequest, { operatorId }), 'support_grant_absent');
  rejects(() => restarted.approveGrant(offline.grant, { signature: signLocalSupportApproval(offline.grant, { consentKey }) }), 'invalid_support_grant');
  const expired = fixture(); expired.approve(); expired.advance(30 * 60_000);
  rejects(() => expired.access.authorizeRequest(expired.request(), { operatorId }), 'support_grant_expired');
});

test('diagnosis releases availability without states, location, free text or credentials', () => {
  const f = fixture(); f.approve();
  const report = f.access.readDiagnosis(f.request({ entities: ['light.kitchen', 'binary_sensor.motion'] }), { observed_at: iso(epoch), states: [{ entity_id: 'light.kitchen', state: 'unavailable', attributes: { access_token: 'SECRET' } }, { entity_id: 'binary_sensor.motion', state: 'on', context: { user_id: 'SECRET' } }, { entity_id: 'device_tracker.private', state: 'SECRET_LOCATION' }], logs: ['SECRET'], token: 'SECRET' }, { operatorId });
  assert.deepEqual(report.data, [{ entity_id: 'light.kitchen', availability: 'unavailable' }, { entity_id: 'binary_sensor.motion', availability: 'available' }]);
  assert.ok(!JSON.stringify(report).includes('SECRET'));
  assert.equal(report.redaction, 'allowlisted_structured_fields_only');
  const health = f.access.readDiagnosis(f.request({ action: 'read_health', entities: [] }), { observed_at: iso(epoch), agent: { connected: true, version: '0.1.2', buffered_events: 0, token: 'SECRET' }, ha: { connected: false, version: '2026.10.2', url: 'SECRET' }, supervisor_token: 'SECRET' }, { operatorId });
  assert.deepEqual(health.data, { agent_connected: true, ha_connected: false, agent_version: '0.1.2', ha_version: '2026.10.2', buffered_events: 0 });
});

test('diagnostic command/log output is structured, scope filtered and bounded', () => {
  const f = fixture(); f.approve();
  const logs = [
    { entity_id: 'light.kitchen', occurred_at: iso(epoch), level: 'error', event_code: 'MAC_NO_ACK', message: 'SECRET' },
    { entity_id: 'light.kitchen', occurred_at: iso(epoch), level: 'SECRET', event_code: 'token=SECRET' },
    { entity_id: 'light.private', occurred_at: iso(epoch), event_code: 'SECRET' },
    { entity_id: 'light.kitchen', occurred_at: iso(epoch - 1), event_code: 'ha_connected' }
  ];
  const report = f.access.readDiagnosis(f.request({ action: 'read_incident_log' }), { observed_at: iso(epoch), logs }, { operatorId });
  assert.equal(report.data.length, 2);
  assert.equal(report.data[0].event_code, 'MAC_NO_ACK');
  assert.equal(report.data[1].event_code, 'redacted');
  assert.ok(!JSON.stringify(report).includes('SECRET'));
  const results = Array.from({ length: 101 }, () => ({ entity_id: 'light.kitchen', occurred_at: iso(epoch), status: 'failed', error_code: 'service_unavailable', message: 'SECRET' }));
  assert.equal(f.access.readDiagnosis(f.request({ action: 'read_command_results' }), { observed_at: iso(epoch), results }, { operatorId }).data.length, 100);
  rejects(() => f.access.readDiagnosis(f.request({ action: 'read_incident_log' }), { observed_at: iso(epoch), logs: Array(2_001).fill(logs[0]) }, { operatorId }), 'diagnostic_rows_exceeded');
});

test('stale, oversized, ambiguous diagnosis and exhausted request budget fail closed', () => {
  const f = fixture(); f.approve();
  for (const observed_at of [iso(epoch - 60_001), iso(epoch + 5_001), 'invalid']) rejects(() => f.access.readDiagnosis(f.request(), { observed_at, states: [] }, { operatorId }), 'diagnosis_stale');
  rejects(() => f.access.readDiagnosis(f.request(), { observed_at: iso(epoch), states: [], raw: 'x'.repeat(4_097) }, { operatorId }), 'input_too_large');
  rejects(() => f.access.readDiagnosis(f.request(), { observed_at: iso(epoch), states: Array(2).fill({ entity_id: 'light.kitchen', state: 'on' }) }, { operatorId }), 'ambiguous_diagnostic_entity');
  for (let index = 0; index < 60; index++) f.access.readDiagnosis(f.request(), { observed_at: iso(epoch), states: [] }, { operatorId });
  rejects(() => f.access.readDiagnosis(f.request(), { observed_at: iso(epoch), states: [] }, { operatorId }), 'support_budget_exhausted');
});
