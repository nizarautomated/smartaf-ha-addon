// Optional privacy encoding only. No clocks, decisions, zone lookup or service
// access: the server interprets these categories in an explicitly bound profile.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const canonical = ['home', 'not_home', 'unknown', 'unavailable'];
const token = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const label = value => typeof value === 'string' && value.length > 0 && [...value].length <= 96 &&
  value === value.trim() && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;

export function validPresenceCategoriesPolicy(value, telemetry) {
  if (!plain(value) || Object.keys(value).length < 1 || Object.keys(value).length > 8) return false;
  const epochs = new Set();
  for (const [entity, config] of Object.entries(value)) {
    if (!/^person\.[a-z0-9_]+$/.test(entity) || !telemetry.entities.includes(entity) ||
        !exact(config, ['schema_version', 'configuration_epoch', 'near_home_values', 'known_zone_values']) ||
        config.schema_version !== 1 || !token(config.configuration_epoch) || epochs.has(config.configuration_epoch)) return false;
    epochs.add(config.configuration_epoch);
    // Preserve the old four-value channel. A category opt-in cannot accidentally
    // permit a raw zone label through the ordinary state field.
    const allowed = telemetry.state_values?.[entity];
    if (!Array.isArray(allowed) || JSON.stringify([...allowed].sort()) !== JSON.stringify([...canonical].sort())) return false;
    const seen = new Set(canonical);
    for (const [key, limit] of [['near_home_values', 8], ['known_zone_values', 32]]) {
      if (!Array.isArray(config[key]) || config[key].length > limit) return false;
      for (const item of config[key]) {
        if (!label(item) || seen.has(item.toLowerCase())) return false;
        seen.add(item.toLowerCase());
      }
    }
  }
  return true;
}

export function selectedPresenceFact({ configuration, entityId, homeId, value, metadata, occurredAt }) {
  const config = configuration?.[entityId], changed = stamp(metadata?.last_changed), observed = stamp(occurredAt);
  if (!config || metadata?.restored !== false || !Number.isFinite(changed) || !Number.isFinite(observed) || changed > observed) return undefined;
  let category = 'unknown';
  if (value === 'not_home' || value === 'unavailable') category = value;
  else if (label(value)) {
    const lower = value.toLowerCase();
    if (lower === 'home') category = 'home';
    else if (config.near_home_values.some(item => item.toLowerCase() === lower)) category = 'near_home';
    else if (config.known_zone_values.some(item => item.toLowerCase() === lower)) category = 'known_zone';
  }
  return { schema_version: 1, home_id: homeId, entity_id: entityId, configuration_epoch: config.configuration_epoch,
    category, observed_at: new Date(observed).toISOString(), last_changed: new Date(changed).toISOString() };
}
