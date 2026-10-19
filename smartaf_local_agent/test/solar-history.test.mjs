import test from 'node:test';
import assert from 'node:assert/strict';
import { createSolarHistoryRequest, normalizeSolarHistory, SOLAR_HISTORY_LIMITS } from '../src/solar-history.mjs';

const ms = Date.parse, seconds = value => ms(value) / 1_000;
function fixture({ now = '2026-10-19T13:00:00Z', timezone = 'Europe/Amsterdam', sunrise = '2026-10-19T06:00:00Z', sunset = '2026-10-19T17:00:00Z', recorded = '2026-10-19T00:00:00Z' } = {}) {
  const current = { homeId: 'home_fixture', timezone, sourceEntities: { sunrise: 'sensor.fixture_rise', sunset: 'sensor.fixture_set' }, connectionEpoch: 'connection_fixture_001', now: ms(now) };
  const request = createSolarHistoryRequest(current);
  const history = { 'sensor.fixture_rise': [{ s: sunrise, lu: seconds(recorded) }], 'sensor.fixture_set': [{ s: sunset, lu: seconds(recorded) }] };
  return { current, request, history, evaluate: changes => normalizeSolarHistory({ ...current, request, history, ...changes }) };
}
const denied = (result, code) => { assert.equal(result.available, false); assert.equal(result.reason_code, code); assert.equal(Object.hasOwn(result, 'fact'), false); };

test('request is fixed to two selected sources and a bounded read-only history window', () => {
  const f = fixture(), q = f.request.query;
  assert.deepEqual(q.entity_ids, ['sensor.fixture_rise', 'sensor.fixture_set']);
  assert.equal(q.type, 'history/history_during_period');
  assert.equal(ms(q.end_time) - ms(q.start_time), SOLAR_HISTORY_LIMITS.windowMs);
  assert.equal(q.no_attributes, true); assert.equal(q.include_start_time_state, true);
  assert.equal(q.minimal_response, false); assert.equal(q.significant_changes_only, true);
  f.current.sourceEntities.sunrise = 'sensor.changed';
  assert.equal(q.entity_ids[0], 'sensor.fixture_rise');
});

test('cold afternoon and cold evening recover today from facts even when newest predictions are tomorrow', () => {
  for (const now of ['2026-10-19T13:00:00Z', '2026-10-19T20:00:00Z']) {
    const f = fixture({ now });
    f.history['sensor.fixture_rise'].push({ s: '2026-10-20T06:02:00Z', lu: seconds('2026-10-19T06:00:00Z') });
    if (now.includes('20:00')) f.history['sensor.fixture_set'].push({ s: '2026-10-20T16:58:00Z', lu: seconds('2026-10-19T17:00:00Z') });
    const result = f.evaluate(); assert.equal(result.available, true);
    assert.equal(result.fact.local_date, '2026-10-19');
    assert.equal(result.fact.sunrise_at, '2026-10-19T06:00:00.000Z');
    assert.equal(result.fact.sunset_at, '2026-10-19T17:00:00.000Z');
    assert.equal(result.fact.observed_at, new Date(f.current.now).toISOString());
    assert.equal(result.fact.home_id, f.current.homeId);
    assert.deepEqual(result.fact.source_entities, f.current.sourceEntities);
    assert.ok(Buffer.byteLength(JSON.stringify(result.fact)) <= SOLAR_HISTORY_LIMITS.factBytes);
    for (const key of ['service', 'execute', 'actions', 'latitude', 'longitude', 'attributes']) assert.equal(Object.hasOwn(result.fact, key), false);
  }
});

test('duplicates and unordered history have one deterministic result and no input/output aliases', () => {
  const f = fixture();
  f.history['sensor.fixture_rise'].push({ s: '2026-10-20T06:02:00Z', lu: seconds('2026-10-19T06:00:00Z') }, { ...f.history['sensor.fixture_rise'][0] });
  const before = structuredClone(f.history), result = f.evaluate();
  f.history['sensor.fixture_rise'].reverse();
  assert.deepEqual(f.evaluate(), result);
  result.fact.source_entities.sunrise = 'sensor.changed';
  assert.equal(f.evaluate().fact.source_entities.sunrise, 'sensor.fixture_rise');
  assert.deepEqual(f.history['sensor.fixture_rise'].toReversed(), before['sensor.fixture_rise']);
});

test('spring and autumn DST facts use actual local dates and exact supplied timestamps', () => {
  for (const values of [
    { now: '2026-03-29T12:00:00Z', sunrise: '2026-03-29T07:20:00+02:00', sunset: '2026-03-29T20:10:00+02:00', recorded: '2026-03-28T23:00:00Z', expected: '2026-03-29T05:20:00.000Z' },
    { now: '2026-10-25T12:00:00Z', sunrise: '2026-10-25T07:20:00+01:00', sunset: '2026-10-25T17:20:00+01:00', recorded: '2026-10-24T22:00:00Z', expected: '2026-10-25T06:20:00.000Z' }
  ]) {
    const result = fixture(values).evaluate(); assert.equal(result.available, true);
    assert.equal(result.fact.sunrise_at, values.expected);
    assert.equal(result.fact.local_date, values.now.slice(0, 10));
  }
});

test('UTC+14 local day can contain a sunrise on the previous UTC date', () => {
  const f = fixture({ timezone: 'Pacific/Kiritimati', now: '2026-10-18T23:00:00Z', recorded: '2026-10-18T10:00:00Z', sunrise: '2026-10-18T16:00:00Z', sunset: '2026-10-19T04:00:00Z' });
  const result = f.evaluate(); assert.equal(result.available, true);
  assert.equal(result.fact.local_date, '2026-10-19');
  assert.equal(result.fact.sunrise_at, '2026-10-18T16:00:00.000Z');
});

test('missing or wrong-day facts never borrow tomorrow minus 24 hours or a previous success', () => {
  const f = fixture(); assert.equal(f.evaluate().available, true);
  f.history['sensor.fixture_rise'][0].s = '2026-10-20T06:02:00Z';
  denied(f.evaluate(), 'solar_history_day_missing');
  delete f.history['sensor.fixture_set']; denied(f.evaluate(), 'solar_history_entities_invalid');
  denied(f.evaluate({ history: undefined }), 'solar_history_entities_invalid');
});

test('fresh read completion, local-day and connection-epoch fences reject delayed and restarted responses', () => {
  const f = fixture();
  denied(f.evaluate({ now: f.current.now + 10_001 }), 'solar_history_request_stale');
  denied(f.evaluate({ now: f.current.now - 1 }), 'solar_history_request_stale');
  denied(f.evaluate({ connectionEpoch: 'connection_fixture_002' }), 'solar_history_context_changed');
  denied(f.evaluate({ homeId: 'home_other' }), 'solar_history_context_changed');
  denied(f.evaluate({ timezone: 'Europe/London' }), 'solar_history_context_changed');
  denied(f.evaluate({ sourceEntities: { sunrise: 'sensor.replacement', sunset: 'sensor.fixture_set' } }), 'solar_history_context_changed');
  const midnight = fixture({ now: '2026-10-19T21:59:59Z' });
  denied(midnight.evaluate({ now: midnight.current.now + 2_000 }), 'solar_history_day_changed');
});

test('query flags, history scope and time-window cannot be broadened after construction', () => {
  const f = fixture();
  for (const change of [{ no_attributes: false }, { entity_ids: ['sensor.fixture_rise', 'sensor.private'] }, { start_time: '2000-01-01T00:00:00Z' }, { end_time: '2026-10-20T00:00:00Z' }]) {
    denied(f.evaluate({ request: { ...f.request, query: { ...f.request.query, ...change } } }), 'solar_history_query_invalid');
  }
  denied(f.evaluate({ history: { ...f.history, 'sensor.private': [{ s: 'private marker' }] } }), 'solar_history_entities_invalid');
});

test('ambiguous same-day solar times or conflicting observations reject the entire pair', () => {
  for (const row of [
    { s: '2026-10-19T06:05:00Z', lu: seconds('2026-10-19T00:30:00Z') },
    { s: '2026-10-20T06:05:00Z', lu: seconds('2026-10-19T00:00:00Z') }
  ]) {
    const f = fixture(); f.history['sensor.fixture_rise'].push(row);
    denied(f.evaluate(), 'solar_history_ambiguous');
  }
  // Changing tomorrow's prediction can indicate a location/configuration
  // change; accepting an older sunrise would mix source calculation contexts.
  const f = fixture(); f.history['sensor.fixture_rise'].push(
    { s: '2026-10-20T06:02:00Z', lu: seconds('2026-10-19T06:00:00Z') },
    { s: '2026-10-20T06:05:00Z', lu: seconds('2026-10-19T07:00:00Z') });
  denied(f.evaluate(), 'solar_history_ambiguous');
});

test('a recorded unknown/unavailable gap after the proof requires new evidence', () => {
  for (const s of ['unknown', 'unavailable']) {
    const f = fixture(); f.history['sensor.fixture_rise'].push({ s, lu: seconds('2026-10-19T07:00:00Z') }, { s: '2026-10-20T06:02:00Z', lu: seconds('2026-10-19T07:05:00Z') });
    denied(f.evaluate(), 'solar_history_discontinuity');
  }
});

test('recording gaps before a new valid prediction do not erase that newer evidence', () => {
  const f = fixture(); f.history['sensor.fixture_rise'].unshift({ s: 'unavailable', lu: seconds('2026-10-18T23:55:00Z') });
  assert.equal(f.evaluate().available, true);
});

test('malformed dates, raw text, historical rows outside the request and future records fail closed', () => {
  for (const s of ['2026-02-30T06:00:00Z', 'Mon, 19 Oct 2026 06:00:00 GMT (private-marker)', '2026-10-19T24:00:00Z', '2026-10-19T06:00:00+15:00', 'private-marker']) {
    const f = fixture(); f.history['sensor.fixture_rise'][0].s = s;
    assert.equal(f.evaluate().available, false);
    assert.equal(JSON.stringify(f.evaluate()).includes('private-marker'), false);
  }
  for (const lu of [seconds('2026-10-17T00:00:00Z'), seconds('2026-10-19T13:00:01Z')]) {
    const f = fixture(); f.history['sensor.fixture_rise'][0].lu = lu; denied(f.evaluate(), 'solar_history_row_stale');
  }
  const f = fixture(); f.history['sensor.fixture_rise'][0].lu = seconds('2026-10-19T07:00:00Z');
  denied(f.evaluate(), 'solar_history_value_invalid');
});

test('microsecond ISO source values are canonicalized without exporting attributes', () => {
  const f = fixture({ sunrise: '2026-10-19T06:00:00.123456+00:00' });
  // Verified HA 2026.10.0 WebSocket shape includes an empty a even when
  // no_attributes=true; this contains no attribute data.
  f.history['sensor.fixture_rise'][0].a = {};
  assert.equal(f.evaluate().fact.sunrise_at, '2026-10-19T06:00:00.123Z');
  f.history['sensor.fixture_rise'][0].a = { private: 'marker' };
  denied(f.evaluate(), 'solar_history_row_invalid');
});

test('bounded series and invalid/ambiguous source configuration cannot produce a fact', () => {
  const f = fixture();
  f.history['sensor.fixture_rise'] = Array.from({ length: 33 }, () => ({ s: '2026-10-19T06:00:00Z', lu: seconds('2026-10-19T00:00:00Z') }));
  denied(f.evaluate(), 'solar_history_series_invalid');
  for (const change of [{ timezone: 'unknown/zone' }, { connectionEpoch: '' }, { sourceEntities: { sunrise: 'sensor.same', sunset: 'sensor.same' } }, { sourceEntities: { sunrise: 'light.test', sunset: 'sensor.fixture_set' } }]) {
    assert.throws(() => createSolarHistoryRequest({ ...f.current, ...change }));
    denied(f.evaluate(change), 'solar_source_configuration_invalid');
  }
  const flipped = fixture({ sunrise: '2026-10-19T17:00:00Z', sunset: '2026-10-19T06:00:00Z' });
  denied(flipped.evaluate(), 'solar_history_order_invalid');
});
