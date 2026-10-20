// Display labels are local presentation metadata, never authorization or an
// operator identity. Keep their shape and size bounded before rendering them.
export function validateSupportDisplay(value) {
  if (value === undefined) return undefined;
  const plain = input => input !== null && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype;
  const name = input => typeof input === 'string' && input.trim() === input && input.length > 0 && [...input].length <= 96 && !/[\p{Cc}\p{Cf}]/u.test(input);
  if (!plain(value) || Object.keys(value).some(key => !['home_name', 'entities'].includes(key)) || Buffer.byteLength(JSON.stringify(value)) > 49_152) throw new TypeError('Invalid support display');
  if (value.home_name !== undefined && !name(value.home_name)) throw new TypeError('Invalid support home label');
  if (value.entities !== undefined && (!plain(value.entities) || Object.keys(value.entities).length > 256 || Object.entries(value.entities).some(([entity, label]) => !/^[a-z_]+\.[a-z0-9_]{1,200}$/.test(entity) || !name(label)))) throw new TypeError('Invalid support entity labels');
  return { ...(value.home_name === undefined ? {} : { home_name: value.home_name }), entities: { ...(value.entities ?? {}) } };
}

// Optional configuration: invalid support settings disable only support and do
// not disturb an otherwise valid existing automation/telemetry configuration.
export function loadSupportConsentConfig(raw, { secureTransport = true } = {}) {
  if (raw === undefined || raw === null || raw === '') return { enabled: false };
  if (typeof raw !== 'string') return { enabled: false, errorCode: 'support_configuration_invalid' };
  if (raw.trim() === '') return { enabled: false };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'port', 'allowed_origins', 'allowed_user_ids', 'display'].includes(key)) || typeof value.enabled !== 'boolean') throw Error();
    if (!value.enabled) return { enabled: false };
    const port = value.port ?? 8099;
    if (!secureTransport || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error();
    if (!Array.isArray(value.allowed_origins) || !value.allowed_origins.length || value.allowed_origins.length > 8 || new Set(value.allowed_origins).size !== value.allowed_origins.length || value.allowed_origins.some(origin => { const url = new URL(origin); return typeof origin !== 'string' || url.protocol !== 'https:' || url.origin !== origin; })) throw Error();
    if (!Array.isArray(value.allowed_user_ids) || !value.allowed_user_ids.length || value.allowed_user_ids.length > 20 || new Set(value.allowed_user_ids).size !== value.allowed_user_ids.length || value.allowed_user_ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) throw Error();
    const display = validateSupportDisplay(value.display);
    return { enabled: true, port, allowedOrigins: [...value.allowed_origins], allowedConsentUsers: [...value.allowed_user_ids], ...(display === undefined ? {} : { display }) };
  } catch { return { enabled: false, errorCode: 'support_configuration_invalid' }; }
}
