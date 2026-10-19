// Optional configuration: invalid support settings disable only support and do
// not disturb an otherwise valid existing automation/telemetry configuration.
export function loadSupportConsentConfig(raw, { secureTransport = true } = {}) {
  if (raw === undefined || raw === null || raw === '') return { enabled: false };
  if (typeof raw !== 'string') return { enabled: false, errorCode: 'support_configuration_invalid' };
  if (raw.trim() === '') return { enabled: false };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'port', 'allowed_origins', 'allowed_user_ids'].includes(key)) || typeof value.enabled !== 'boolean') throw Error();
    if (!value.enabled) return { enabled: false };
    const port = value.port ?? 8099;
    if (!secureTransport || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error();
    if (!Array.isArray(value.allowed_origins) || !value.allowed_origins.length || value.allowed_origins.length > 8 || new Set(value.allowed_origins).size !== value.allowed_origins.length || value.allowed_origins.some(origin => { const url = new URL(origin); return typeof origin !== 'string' || url.protocol !== 'https:' || url.origin !== origin; })) throw Error();
    if (!Array.isArray(value.allowed_user_ids) || !value.allowed_user_ids.length || value.allowed_user_ids.length > 20 || new Set(value.allowed_user_ids).size !== value.allowed_user_ids.length || value.allowed_user_ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) throw Error();
    return { enabled: true, port, allowedOrigins: [...value.allowed_origins], allowedConsentUsers: [...value.allowed_user_ids] };
  } catch { return { enabled: false, errorCode: 'support_configuration_invalid' }; }
}
