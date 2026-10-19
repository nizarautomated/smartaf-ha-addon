// Fact normalization only: no HA connection, device commands, automation
// decisions, location, credentials, clock scheduling or persistent state.
export const SOLAR_HISTORY_LIMITS = Object.freeze({ windowMs: 36 * 60 * 60_000, requestMs: 10_000, rowsPerEntity: 32, factBytes: 2_048 });
const HOME = /^home_[a-z0-9][a-z0-9_]{2,47}$/;
const ENTITY = /^sensor\.[a-z0-9_]{1,120}$/;
const EPOCH = /^[A-Za-z0-9_-]{16,96}$/;
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const fields = (value, required, optional = []) => plain(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) => [...required, ...optional].includes(key) && Object.hasOwn(descriptor, 'value'));
const iso = value => new Date(value).toISOString();
function reject(code) { throw Object.assign(new Error('Solar history unavailable'), { code }); }
function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, , offset] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2200 || calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return NaN;
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59 || (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4)) !== 0))) return NaN;
  return Date.parse(value);
}
function dateAt(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}
function configuration(value) {
  if (!fields(value, ['homeId', 'timezone', 'sourceEntities', 'connectionEpoch', 'now'], ['configurationEpoch']) || typeof value.homeId !== 'string' || !HOME.test(value.homeId) ||
      typeof value.timezone !== 'string' || value.timezone.length > 64 || !fields(value.sourceEntities, ['sunrise', 'sunset']) ||
      Object.values(value.sourceEntities).some(id => typeof id !== 'string' || !ENTITY.test(id)) || value.sourceEntities.sunrise === value.sourceEntities.sunset ||
      typeof value.connectionEpoch !== 'string' || !EPOCH.test(value.connectionEpoch) ||
      (value.configurationEpoch !== undefined && (typeof value.configurationEpoch !== 'string' || !EPOCH.test(value.configurationEpoch))) ||
      !Number.isSafeInteger(value.now) || !Number.isFinite(timestamp(iso(value.now)))) reject('solar_source_configuration_invalid');
  try { dateAt(value.now, value.timezone); } catch { reject('solar_source_configuration_invalid'); }
  return value;
}

// The caller must bind these two IDs to the original HA Sun timestamp sensors
// during onboarding. Never let a remote request choose IDs, time ranges or flags.
export function createSolarHistoryRequest(input) {
  const config = configuration(input);
  return {
    schema_version: 1, home_id: config.homeId, timezone: config.timezone,
    local_date: dateAt(config.now, config.timezone), connection_epoch: config.connectionEpoch,
    ...(config.configurationEpoch === undefined ? {} : { configuration_epoch: config.configurationEpoch }),
    requested_at: iso(config.now), source_entities: { ...config.sourceEntities },
    query: { type: 'history/history_during_period', start_time: iso(config.now - SOLAR_HISTORY_LIMITS.windowMs), end_time: iso(config.now),
      entity_ids: [config.sourceEntities.sunrise, config.sourceEntities.sunset], include_start_time_state: true,
      significant_changes_only: true, minimal_response: false, no_attributes: true }
  };
}

function readSeries(rows, request, targetDate) {
  if (!Array.isArray(rows) || !rows.length || rows.length > SOLAR_HISTORY_LIMITS.rowsPerEntity || Object.keys(rows).length !== rows.length ||
      Object.values(Object.getOwnPropertyDescriptors(rows)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) reject('solar_history_series_invalid');
  const start = timestamp(request.query.start_time), end = timestamp(request.query.end_time);
  const records = rows.map(row => {
    // HA still includes a:{} with no_attributes=true. Only that empty container
    // is accepted; all actual attributes and arbitrary fields are rejected.
    // A full REST state response is not interchangeable with this.
    if (!fields(row, ['s', 'lu'], ['lc', 'a']) || (row.a !== undefined && !fields(row.a, [])) || typeof row.s !== 'string' || row.s.length > 40 || typeof row.lu !== 'number' || !Number.isFinite(row.lu)) reject('solar_history_row_invalid');
    const observed = Math.round(row.lu * 1_000);
    if (!Number.isSafeInteger(observed) || observed < start || observed > end) reject('solar_history_row_stale');
    if (row.lc !== undefined && (typeof row.lc !== 'number' || !Number.isFinite(row.lc) || row.lc < 0 || row.lc > row.lu)) reject('solar_history_row_invalid');
    if (['unknown', 'unavailable'].includes(row.s)) return { observed, at: null };
    const at = timestamp(row.s);
    // next_* is a prediction made before the event. A row received after its
    // claimed astronomical event cannot establish that earlier prediction.
    if (!Number.isFinite(at) || at < observed) reject('solar_history_value_invalid');
    return { observed, at };
  }).sort((left, right) => left.observed - right.observed || (left.at ?? -1) - (right.at ?? -1));
  const perDate = new Map(), perObservation = new Map();
  for (const row of records) {
    if (perObservation.has(row.observed) && perObservation.get(row.observed) !== row.at) reject('solar_history_ambiguous');
    perObservation.set(row.observed, row.at);
    if (row.at === null) continue;
    const day = dateAt(row.at, request.timezone);
    if (perDate.has(day) && perDate.get(day) !== row.at) reject('solar_history_ambiguous');
    perDate.set(day, row.at);
  }
  const at = perDate.get(targetDate);
  if (at === undefined) reject('solar_history_day_missing');
  const evidence = records.filter(row => row.at === at).at(-1);
  if (records.some(row => row.observed >= evidence.observed && row.at === null)) reject('solar_history_discontinuity');
  return { at, effective: evidence.observed };
}

// Stateless by design. Every response is checked against current configuration
// and a newly random connection epoch, including after process restart. No old
// request, cached success, partial pair or failed query becomes a fallback fact.
export function normalizeSolarHistory({ request, history, ...current } = {}) {
  try {
    const config = configuration(current);
    if (!fields(request, ['schema_version', 'home_id', 'timezone', 'local_date', 'connection_epoch', 'requested_at', 'source_entities', 'query'], ['configuration_epoch']) || request.schema_version !== 1) reject('solar_history_request_invalid');
    if (request.home_id !== config.homeId || request.timezone !== config.timezone || request.connection_epoch !== config.connectionEpoch || request.configuration_epoch !== config.configurationEpoch ||
        !fields(request.source_entities, ['sunrise', 'sunset']) || request.source_entities.sunrise !== config.sourceEntities.sunrise || request.source_entities.sunset !== config.sourceEntities.sunset) reject('solar_history_context_changed');
    const requested = timestamp(request.requested_at);
    if (!Number.isFinite(requested) || requested > config.now || config.now - requested > SOLAR_HISTORY_LIMITS.requestMs) reject('solar_history_request_stale');
    const expected = createSolarHistoryRequest({ ...config, now: requested });
    const query = request.query;
    if (!fields(query, ['type', 'start_time', 'end_time', 'entity_ids', 'include_start_time_state', 'significant_changes_only', 'minimal_response', 'no_attributes']) ||
        Object.keys(expected.query).some(key => JSON.stringify(query[key]) !== JSON.stringify(expected.query[key]))) reject('solar_history_query_invalid');
    const today = dateAt(config.now, config.timezone);
    if (request.local_date !== today || request.local_date !== expected.local_date) reject('solar_history_day_changed');
    const ids = Object.values(config.sourceEntities);
    if (!fields(history, ids)) reject('solar_history_entities_invalid');
    const sunrise = readSeries(history[config.sourceEntities.sunrise], request, today);
    const sunset = readSeries(history[config.sourceEntities.sunset], request, today);
    if (sunrise.at >= sunset.at) reject('solar_history_order_invalid');
    const fact = {
      schema_version: 1, home_id: config.homeId, timezone: config.timezone, local_date: today,
      source: 'ha_sun_timestamp_history', source_entities: { ...config.sourceEntities }, connection_epoch: config.connectionEpoch,
      ...(config.configurationEpoch === undefined ? {} : { configuration_epoch: config.configurationEpoch }),
      observed_at: iso(config.now), source_effective_at: { sunrise: iso(sunrise.effective), sunset: iso(sunset.effective) },
      sunrise_at: iso(sunrise.at), sunset_at: iso(sunset.at)
    };
    if (Buffer.byteLength(JSON.stringify(fact)) > SOLAR_HISTORY_LIMITS.factBytes) reject('solar_history_fact_too_large');
    return { available: true, reason_code: 'solar_day_fact_ready', fact };
  } catch (error) {
    return { available: false, reason_code: typeof error?.code === 'string' && /^solar_[a-z_]+$/.test(error.code) ? error.code : 'solar_history_invalid' };
  }
}
