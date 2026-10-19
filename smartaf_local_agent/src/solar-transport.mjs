import { createSolarHistoryRequest } from './solar-history.mjs';

const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const localDate = (at, timezone) => {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(Date.parse(at));
  return ['year','month','day'].map(key=>parts.find(item=>item.type===key).value).join('-');
};
export function validSolarHistoryPolicy(value) {
  if (!exact(value, ['timezone', 'source_entities', 'configuration_epoch'])) return false;
  try {
    createSolarHistoryRequest({ homeId: 'home_validation', timezone: value.timezone, sourceEntities: value.source_entities,
      configurationEpoch: value.configuration_epoch, connectionEpoch: 'validation_epoch_0001', now: 1792411200000 });
    return typeof value.configuration_epoch === 'string';
  } catch { return false; }
}

// This boundary only copies the bounded factual envelope, never history rows,
// locations, arbitrary attributes or a remotely chosen history query.
export function selectedSolarSnapshot(payload, { configuration, homeId, occurredAt }) {
  if (!configuration) return {};
  const context = payload?.solar_context;
  if (!exact(context, ['schema_version','home_id','timezone','source_entities','configuration_epoch','connection_epoch','observed_at']) ||
      context.schema_version !== 1 || context.home_id !== homeId || context.timezone !== configuration.timezone ||
      context.configuration_epoch !== configuration.configuration_epoch || typeof context.connection_epoch !== 'string' || !/^[A-Za-z0-9_-]{16,96}$/.test(context.connection_epoch) ||
      !exact(context.source_entities, ['sunrise','sunset']) || ['sunrise','sunset'].some(key => context.source_entities[key] !== configuration.source_entities[key]) ||
      !iso(context.observed_at) || context.observed_at !== occurredAt) return {};
  const result = { solar_context: structuredClone(context) }, fact = payload.solar_day;
  if (fact === undefined) return result;
  if (!exact(fact, ['schema_version','home_id','timezone','local_date','source','source_entities','configuration_epoch','connection_epoch','observed_at','source_effective_at','sunrise_at','sunset_at']) ||
      Buffer.byteLength(JSON.stringify(fact)) > 2048 || fact.schema_version !== 1 || fact.source !== 'ha_sun_timestamp_history' ||
      ['home_id','timezone','configuration_epoch','connection_epoch'].some(key => fact[key] !== context[key]) ||
      !exact(fact.source_entities, ['sunrise','sunset']) || ['sunrise','sunset'].some(key => fact.source_entities[key] !== context.source_entities[key]) ||
      !/^\d{4}-\d\d-\d\d$/.test(fact.local_date || '') || !exact(fact.source_effective_at, ['sunrise','sunset']) ||
      ![fact.observed_at,fact.sunrise_at,fact.sunset_at,...Object.values(fact.source_effective_at)].every(iso) ||
      Date.parse(fact.observed_at) > Date.parse(occurredAt) || Date.parse(occurredAt) - Date.parse(fact.observed_at) > 10000) return result;
  const today = localDate(occurredAt,configuration.timezone), observed=Date.parse(fact.observed_at);
  if(fact.local_date!==today || Date.parse(fact.sunrise_at)>=Date.parse(fact.sunset_at) || ['sunrise','sunset'].some(key=>{
    const effective=Date.parse(fact.source_effective_at[key]);
    return localDate(fact[`${key}_at`],configuration.timezone)!==today || effective>observed || effective>Date.parse(fact[`${key}_at`]) || observed-effective>36*3600000+10000;
  })) return result;
  result.solar_day = structuredClone(fact);
  return result;
}
