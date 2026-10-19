import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { validSolarHistoryPolicy, selectedSolarSnapshot } from './solar-transport.mjs';

const HOME = /^home_[a-z0-9][a-z0-9_]{2,47}$/;
const OPERATOR = /^operator_[a-z0-9][a-z0-9_]{2,63}$/;
const ENTITY = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;
const ID = /^[a-z][a-z0-9_-]{2,95}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const FORBIDDEN_DOMAINS = new Set(["scene", "group", "script", "automation", "homeassistant", "python_script", "shell_command", "rest_command", "button", "update", "lock", "alarm_control_panel"]);
const RESERVED_PARAMETERS = new Set(["entity_id", "target", "device_id", "area_id", "floor_id", "domain", "service", "action", "variables", "context"]);
// A registry entry alone does not prove a direct target: template/universal,
// switch_as_x and MQTT may delegate to arbitrary other entities/services.
export const DIRECT_TARGET_PLATFORMS = Object.freeze(["zha", "zwave_js", "esphome", "hue", "shelly", "tplink", "input_boolean"]);
const compiledPolicies = new WeakSet();
export const SUPPORT_READ_ACTIONS = Object.freeze(["read_health", "read_entity_availability", "read_command_results", "read_incident_log"]);
export const SUPPORT_LIMITS = Object.freeze({ grantMs: 30 * 60_000, entities: 10, requestAgeMs: 60_000, snapshotAgeMs: 60_000, futureSkewMs: 5_000, rows: 2_000, resultRows: 100, inputBytes: 1_000_000, reportBytes: 262_144, requestsPerGrant: 60, grantsPerSession: 100 });

const number = (min, max, integer = false) => ({ type: "number", min, max, integer });
const enumeration = (...values) => ({ type: "enum", values });
const SERVICE_PARAMETERS = {
  "light.turn_on": { brightness_pct: number(0, 100), brightness: number(0, 255, true), color_temp_kelvin: number(1_000, 20_000, true), transition: number(0, 300), flash: enumeration("short", "long") },
  "light.turn_off": { transition: number(0, 300) },
  "switch.turn_on": {}, "switch.turn_off": {},
  "input_boolean.turn_on": {}, "input_boolean.turn_off": {},
  "fan.turn_on": {}, "fan.turn_off": {}, "fan.set_percentage": { percentage: number(0, 100) },
  "cover.open_cover": {}, "cover.close_cover": {}, "cover.stop_cover": {}, "cover.set_cover_position": { position: number(0, 100, true) },
  "climate.set_temperature": { temperature: number(-50, 100), target_temp_high: number(-50, 100), target_temp_low: number(-50, 100), hvac_mode: enumeration("off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only") },
  "climate.set_hvac_mode": { hvac_mode: enumeration("off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only") },
  "media_player.volume_set": { volume_level: number(0, 1) },
  "media_player.media_play": {}, "media_player.media_pause": {}, "media_player.media_stop": {}, "media_player.turn_on": {}, "media_player.turn_off": {},
  "vacuum.start": {}, "vacuum.pause": {}, "vacuum.stop": {}, "vacuum.return_to_base": {}
};
export const STRICT_RUNTIME_SERVICES = Object.freeze(Object.keys(SERVICE_PARAMETERS));

export class LocalAccessError extends Error {
  constructor(code) { super("Lokale toegangsgrens weigert de aanvraag"); this.name = "LocalAccessError"; this.code = code; this.safetyRejection = true; }
}
function deny(code) { throw new LocalAccessError(code); }
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function keys(value, allowed, code = "invalid_access_policy") {
  if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key))) deny(code);
}
function stamp(value) { return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN; }
function boundJson(value, bytes = 65_536) {
  let nodes = 0;
  const inspect = (item, depth = 0) => {
    if (++nodes > 20_000 || depth > 10) deny("input_too_large");
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return;
    if (typeof item === "string") { if (item.length > 4_096) deny("input_too_large"); return; }
    if (Array.isArray(item)) { if (item.length > 5_000) deny("input_too_large"); item.forEach((child) => inspect(child, depth + 1)); return; }
    if (!plain(item)) deny("invalid_json_data");
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
      if (!Object.hasOwn(descriptor, "value")) deny("invalid_json_data");
      inspect(descriptor.value, depth + 1);
    }
  };
  inspect(value);
  if (Buffer.byteLength(JSON.stringify(value)) > bytes) deny("input_too_large");
}
function strings(value, pattern, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length || !value.every((item) => typeof item === "string" && pattern.test(item))) deny(code);
}
function entities(value, maximum = 512, code = "invalid_access_policy") { strings(value, ENTITY, maximum, code); }
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function compileAccessPolicy(input, { homeId } = {}) {
  if (!HOME.test(homeId || "")) deny("invalid_home");
  // Only the integration boundary may select legacy mode. A supplied enabled
  // policy never degrades to legacy after a validation failure.
  if (input === null || input === undefined) return null;
  boundJson(input);
  keys(input, ["schema_version", "home_id", "revision", "enabled", "runtime", "telemetry", "support"]);
  if (input.schema_version !== 1 || input.home_id !== homeId || !Number.isSafeInteger(input.revision) || input.revision < 1 || typeof input.enabled !== "boolean") deny("invalid_access_policy");
  if (input.enabled === false && input.support?.enabled === true) deny("support_requires_strict_policy");
  keys(input.runtime, ["permissions"]);
  if (!Array.isArray(input.runtime.permissions) || input.runtime.permissions.length > 512) deny("invalid_access_policy");
  const pairs = new Set();
  for (const permission of input.runtime.permissions) {
    keys(permission, ["entity_id", "service", "parameters", "required"]);
    const domain = permission.entity_id?.split(".")[0];
    if (!ENTITY.test(permission.entity_id || "") || FORBIDDEN_DOMAINS.has(domain) || !Object.hasOwn(SERVICE_PARAMETERS, permission.service || "") || permission.service.split(".")[0] !== domain) deny("unsafe_runtime_permission");
    const pair = `${permission.entity_id}:${permission.service}`;
    if (pairs.has(pair)) deny("duplicate_runtime_permission");
    pairs.add(pair);
    if (!plain(permission.parameters) || Object.keys(permission.parameters).length > 16) deny("invalid_access_policy");
    strings(permission.required, /^[a-z][a-z0-9_]{0,63}$/, 16, "invalid_access_policy");
    if (permission.required.some((key) => !Object.hasOwn(permission.parameters, key))) deny("invalid_access_policy");
    for (const [key, rule] of Object.entries(permission.parameters)) {
      const hard = Object.hasOwn(SERVICE_PARAMETERS[permission.service], key) && SERVICE_PARAMETERS[permission.service][key];
      if (RESERVED_PARAMETERS.has(key) || !hard) deny("unsafe_runtime_parameter");
      if (hard.type === "number") {
        keys(rule, ["type", "min", "max"]);
        if (rule.type !== "number" || !Number.isFinite(rule.min) || !Number.isFinite(rule.max) || rule.min > rule.max || rule.min < hard.min || rule.max > hard.max) deny("unsafe_runtime_parameter");
      } else {
        keys(rule, ["type", "values"]);
        strings(rule.values, /^[a-zA-Z0-9 _-]{1,64}$/, 32, "unsafe_runtime_parameter");
        if (rule.type !== "enum" || !rule.values.length || rule.values.some((value) => !hard.values.includes(value))) deny("unsafe_runtime_parameter");
      }
    }
  }
  keys(input.telemetry, ["entities", "state_values", "solar_history"]);
  if (input.telemetry.solar_history !== undefined && !validSolarHistoryPolicy(input.telemetry.solar_history)) deny('invalid_solar_history_policy');
  entities(input.telemetry.entities);
  if (input.telemetry.state_values !== undefined) {
    if (!plain(input.telemetry.state_values) || Object.keys(input.telemetry.state_values).length > 512) deny("invalid_access_policy");
    for (const [entityId, allowed] of Object.entries(input.telemetry.state_values)) {
      if (!input.telemetry.entities.includes(entityId)) deny("invalid_access_policy");
      strings(allowed, /^[a-zA-Z0-9 _.-]{1,128}$/, 32, "invalid_access_policy");
      if (!allowed.length) deny("invalid_access_policy");
    }
  }
  const support = input.support ?? { enabled: false, operators: [], entities: [], actions: [] };
  keys(support, ["enabled", "operators", "entities", "actions"]);
  if (typeof support.enabled !== "boolean") deny("invalid_access_policy");
  strings(support.operators, OPERATOR, 20, "invalid_access_policy");
  entities(support.entities, 512);
  strings(support.actions, /^[a-z_]+$/, 4, "invalid_access_policy");
  if (support.actions.some((action) => !SUPPORT_READ_ACTIONS.includes(action))) deny("unsafe_support_action");
  const compiled = freeze(structuredClone({ ...input, support }));
  compiledPolicies.add(compiled);
  return compiled;
}

export function authorizeRuntimeCommand(command, { policy, homeId, entityMetadata, now = Date.now() } = {}) {
  if (!HOME.test(homeId || "") || command?.home_id !== homeId) deny("wrong_home");
  if ((command.access_scope ?? "runtime") !== "runtime" || command.support_grant !== undefined || command.grant_id !== undefined) deny("runtime_support_separation");
  if (policy === null || policy === undefined) return { authorized: true, mode: "legacy", policy_revision: null };
  if (!compiledPolicies.has(policy) || policy.home_id !== homeId) deny("invalid_access_policy");
  if (policy.enabled !== true) deny("runtime_policy_disabled");
  if (command.policy_revision !== policy.revision) deny("policy_revision_mismatch");
  if (!Number.isFinite(now) || !Number.isFinite(stamp(command.not_before)) || !Number.isFinite(stamp(command.expires_at)) || stamp(command.not_before) > now || stamp(command.expires_at) <= now) deny("runtime_deadline");
  const permission = policy.runtime.permissions.find((item) => item.entity_id === command.entity_id && item.service === command.service);
  if (!permission) deny("runtime_permission_denied");
  const metadata = entityMetadata instanceof Map ? entityMetadata.get(command.entity_id) : undefined;
  if (!plain(metadata) || metadata.entity_id !== command.entity_id || metadata.registry_present !== true || metadata.disabled !== false || metadata.is_group !== false || !Array.isArray(metadata.members) || metadata.members.length || !DIRECT_TARGET_PLATFORMS.includes(metadata.platform)) deny("runtime_target_not_direct");
  boundJson(command.data, 4_096);
  if (!plain(command.data) || Object.keys(command.data).length > 16) deny("runtime_parameter_denied");
  for (const required of permission.required) if (!Object.hasOwn(command.data, required)) deny("runtime_parameter_missing");
  for (const [key, value] of Object.entries(command.data)) {
    const rule = Object.hasOwn(permission.parameters, key) && permission.parameters[key];
    if (!rule || RESERVED_PARAMETERS.has(key)) deny("runtime_parameter_denied");
    if (rule.type === "number") {
      if (!Number.isFinite(value) || typeof value !== "number" || value < rule.min || value > rule.max || (SERVICE_PARAMETERS[command.service][key].integer && !Number.isInteger(value))) deny("runtime_parameter_denied");
    } else if (!rule.values.includes(value)) deny("runtime_parameter_denied");
  }
  if (command.guard && !policy.telemetry.entities.includes(command.guard.entity_id)) deny("runtime_guard_entity_denied");
  return { authorized: true, mode: "strict", policy_revision: policy.revision };
}

function safeMetadata(metadata, entityId) {
  if (!plain(metadata)) return {};
  const result = {};
  if (Number.isFinite(stamp(metadata.last_changed))) result.last_changed = new Date(stamp(metadata.last_changed)).toISOString();
  if (typeof metadata.restored === "boolean") result.restored = metadata.restored;
  if (entityId === "sun.sun" && plain(metadata.solar)) {
    const solar = Object.fromEntries(["next_rising", "next_setting"].filter((key) => Number.isFinite(stamp(metadata.solar[key]))).map((key) => [key, new Date(stamp(metadata.solar[key])).toISOString()]));
    if (Object.keys(solar).length) result.solar = solar;
  }
  return Object.keys(result).length ? { metadata: result } : {};
}
export function solarHistoryConfiguration(policy, homeId) {
  if (policy === null || policy === undefined) return null;
  if (!compiledPolicies.has(policy) || policy.home_id !== homeId) deny('invalid_access_policy');
  return policy.enabled ? policy.telemetry.solar_history || null : null;
}
export function selectTelemetry(event, { policy, homeId } = {}) {
  if (!HOME.test(homeId || "") || event?.home_id !== homeId) deny("wrong_home");
  if (policy === null || policy === undefined) return event;
  if (!compiledPolicies.has(policy) || policy.home_id !== homeId) deny("invalid_access_policy");
  if (policy.enabled !== true) return null;
  const selected = new Set(policy.telemetry.entities);
  // A privacy filter, never an inference: an unlisted zone is unknown, not away.
  const stateValue = (entityId, value) => value === null || !policy.telemetry.state_values?.[entityId]
    ? value : policy.telemetry.state_values[entityId].includes(value) ? value : 'unknown';
  const envelope = Object.fromEntries(["protocol_version", "home_id", "agent_id", "event_id", "sequence", "occurred_at", "type"].map((key) => [key, event[key]]));
  const origin = ["manual", "automation", "unknown"].includes(event.origin) ? event.origin : "unknown";
  if (event.type === "state_changed") {
    if (!selected.has(event.entity_id)) return null;
    if (typeof event.new_state !== "string" || event.new_state.length > 128 || !(event.old_state === null || (typeof event.old_state === "string" && event.old_state.length <= 128))) deny("invalid_telemetry");
    return { ...envelope, entity_id: event.entity_id, old_state: stateValue(event.entity_id,event.old_state), new_state: stateValue(event.entity_id,event.new_state), origin, ...safeMetadata(event.metadata, event.entity_id) };
  }
  if (event.type === "state_snapshot") {
    if (!Array.isArray(event.payload?.states) || event.payload.states.length > 5_000) deny("invalid_telemetry");
    const states = event.payload.states.filter((item) => selected.has(item?.entity_id)).map((item) => {
      if (typeof item.state !== "string" || item.state.length > 128) deny("invalid_telemetry");
      return { entity_id: item.entity_id, state: stateValue(item.entity_id,item.state), ...safeMetadata(item.metadata, item.entity_id) };
    });
    if (new Set(states.map((item) => item.entity_id)).size !== states.length) deny("invalid_telemetry");
    return { ...envelope, payload: { states, ...selectedSolarSnapshot(event.payload, {
      configuration: policy.telemetry.solar_history, homeId, occurredAt: event.occurred_at
    }) } };
  }
  if (event.type === "event" && event.event_type === "call_service") {
    if (!STRICT_RUNTIME_SERVICES.includes(event.payload?.service) || !Array.isArray(event.payload?.entity_ids)) return null;
    const entityIds = [...new Set(event.payload.entity_ids.filter((id) => selected.has(id)))];
    if (!entityIds.length) return null;
    return { ...envelope, event_type: "call_service", origin, payload: { service: event.payload.service, entity_ids: entityIds } };
  }
  return null;
}

function validateGrant(grant, { homeId, policy, sessionId, now }) {
  boundJson(grant, 8_192);
  keys(grant, ["schema_version", "grant_id", "incident_id", "home_id", "operator_id", "local_session_id", "policy_revision", "actions", "entities", "issued_at", "expires_at"], "invalid_support_grant");
  if (!policy?.enabled || !policy?.support.enabled) deny("support_disabled");
  if (grant.schema_version !== 1 || !ID.test(grant.grant_id || "") || !ID.test(grant.incident_id || "") || grant.home_id !== homeId || grant.policy_revision !== policy.revision || grant.local_session_id !== sessionId || !policy.support.operators.includes(grant.operator_id)) deny("invalid_support_grant");
  entities(grant.entities, SUPPORT_LIMITS.entities, "invalid_support_grant");
  strings(grant.actions, /^[a-z_]+$/, 4, "invalid_support_grant");
  if (!grant.actions.length || grant.actions.some((action) => !policy.support.actions.includes(action)) || grant.entities.some((entity) => !policy.support.entities.includes(entity))) deny("support_scope_denied");
  const issued = stamp(grant.issued_at), expires = stamp(grant.expires_at);
  if (!Number.isFinite(now) || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now || expires <= issued || expires - issued > SUPPORT_LIMITS.grantMs) deny("support_grant_expired");
  return grant;
}
function signingKey(key) {
  if (!(typeof key === "string" || key instanceof Uint8Array) || Buffer.byteLength(key) < 32) deny("local_consent_unconfigured");
  return key;
}
export function signLocalSupportApproval(grant, { consentKey } = {}) {
  boundJson(grant, 8_192);
  return createHmac("sha256", signingKey(consentKey)).update(canonical(grant)).digest("hex");
}

const SAFE_CODES = new Set(["ha_connected", "ha_disconnected", "agent_offline", "ha_connection_changed", "command_expired", "guard_condition_changed", "guard_state_missing", "guard_state_unavailable", "guard_observation_superseded", "network_timeout", "service_unavailable", "device_unavailable", "MAC_NO_ACK", "execution_outcome_unknown", "command_succeeded", "command_failed"]);
const safeCode = (code) => SAFE_CODES.has(code) ? code : "redacted";
const safeVersion = (value) => typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,32})?$/.test(value) ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;

export class LocalSupportAccess {
  #grants = new Map(); #revoked = new Set(); #sessionId = `session_${randomUUID()}`; #consentKey; #online = false;
  constructor({ homeId, policy = null, consentKey, clock = Date.now } = {}) {
    if (!HOME.test(homeId || "") || (policy && (!compiledPolicies.has(policy) || policy.home_id !== homeId)) || typeof clock !== "function") deny("invalid_access_policy");
    this.homeId = homeId; this.policy = policy; this.clock = clock; this.#consentKey = consentKey;
    Object.freeze(this);
  }
  get sessionId() { return this.#sessionId; }
  setOnline(online) {
    if (typeof online !== "boolean") deny("invalid_support_connection");
    if (!online && this.#online) { this.#grants.clear(); this.#revoked.clear(); this.#sessionId = `session_${randomUUID()}`; }
    this.#online = online;
  }
  approveGrant(grant, { signature } = {}) {
    if (!this.#online) deny("support_offline");
    validateGrant(grant, { homeId: this.homeId, policy: this.policy, sessionId: this.#sessionId, now: this.clock() });
    if (this.#revoked.has(grant.grant_id) || this.#grants.has(grant.grant_id)) deny("support_grant_reused");
    if (this.#grants.size + this.#revoked.size >= SUPPORT_LIMITS.grantsPerSession) deny("support_session_budget_exhausted");
    const expected = signLocalSupportApproval(grant, { consentKey: this.#consentKey });
    if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) deny("local_consent_required");
    this.#grants.set(grant.grant_id, { grant: freeze(structuredClone(grant)), requests: 0 });
    return { approved: true, grant_id: grant.grant_id, local_session_id: this.#sessionId, expires_at: grant.expires_at };
  }
  revoke(grantId) {
    if (!ID.test(grantId || "")) deny("invalid_support_grant");
    if (!this.#grants.has(grantId) && !this.#revoked.has(grantId) && this.#grants.size + this.#revoked.size >= SUPPORT_LIMITS.grantsPerSession) deny("support_session_budget_exhausted");
    this.#revoked.add(grantId); this.#grants.delete(grantId);
    return { revoked: true, grant_id: grantId };
  }
  authorizeRequest(request, { operatorId } = {}) {
    if (!this.policy?.enabled || !this.policy?.support.enabled) deny("support_disabled");
    if (!this.#online) deny("support_offline");
    boundJson(request, 8_192);
    keys(request, ["grant_id", "incident_id", "home_id", "operator_id", "local_session_id", "policy_revision", "action", "entities", "requested_at"], "invalid_support_request");
    const record = this.#grants.get(request.grant_id);
    if (!record || this.#revoked.has(request.grant_id)) deny("support_grant_absent");
    const grant = validateGrant(record.grant, { homeId: this.homeId, policy: this.policy, sessionId: this.#sessionId, now: this.clock() });
    for (const key of ["home_id", "operator_id", "incident_id", "local_session_id", "policy_revision"]) if (request[key] !== grant[key]) deny("support_context_mismatch");
    if (!OPERATOR.test(operatorId || "") || operatorId !== grant.operator_id) deny("support_operator_denied");
    entities(request.entities, SUPPORT_LIMITS.entities, "invalid_support_request");
    if (!grant.actions.includes(request.action) || request.entities.some((entity) => !grant.entities.includes(entity)) || (request.action !== "read_health" && !request.entities.length)) deny("support_scope_denied");
    const requested = stamp(request.requested_at), now = this.clock();
    if (!Number.isFinite(requested) || requested < stamp(grant.issued_at) || requested > now || now - requested > SUPPORT_LIMITS.requestAgeMs) deny("support_request_stale");
    if (record.requests >= SUPPORT_LIMITS.requestsPerGrant) deny("support_budget_exhausted");
    return { grant_id: grant.grant_id, home_id: grant.home_id, operator_id: grant.operator_id, incident_id: grant.incident_id, action: request.action, entities: [...request.entities], expires_at: grant.expires_at };
  }
  readDiagnosis(request, supplied, context) {
    const authorization = this.authorizeRequest(request, context);
    boundJson(supplied, SUPPORT_LIMITS.inputBytes);
    if (!plain(supplied)) deny("invalid_diagnostic_data");
    const now = this.clock(), observed = stamp(supplied.observed_at);
    if (!Number.isFinite(observed) || observed > now + SUPPORT_LIMITS.futureSkewMs || now - observed > SUPPORT_LIMITS.snapshotAgeMs) deny("diagnosis_stale");
    const selected = new Set(authorization.entities);
    let data;
    if (request.action === "read_health") {
      data = { agent_connected: typeof supplied.agent?.connected === "boolean" ? supplied.agent.connected : null, ha_connected: typeof supplied.ha?.connected === "boolean" ? supplied.ha.connected : null, agent_version: safeVersion(supplied.agent?.version), ha_version: safeVersion(supplied.ha?.version), buffered_events: count(supplied.agent?.buffered_events) };
    } else if (request.action === "read_entity_availability") {
      if (!Array.isArray(supplied.states)) deny("invalid_diagnostic_data");
      data = authorization.entities.map((entityId) => {
        const matches = supplied.states.filter((item) => item?.entity_id === entityId);
        if (matches.length > 1) deny("ambiguous_diagnostic_entity");
        const state = matches[0];
        const availability = !state ? "missing" : ["unknown", "unavailable"].includes(state.state) ? state.state : typeof state.state === "string" ? "available" : "unknown";
        return { entity_id: entityId, availability };
      });
    } else {
      const rows = request.action === "read_command_results" ? supplied.results : supplied.logs;
      if (!Array.isArray(rows) || rows.length > SUPPORT_LIMITS.rows) deny("diagnostic_rows_exceeded");
      const grant = this.#grants.get(request.grant_id).grant;
      const relevant = rows.filter((row) => selected.has(row?.entity_id) && Number.isFinite(stamp(row.occurred_at)) && stamp(row.occurred_at) >= stamp(grant.issued_at) && stamp(row.occurred_at) <= now);
      const maximum = request.action === "read_command_results" ? SUPPORT_LIMITS.resultRows : SUPPORT_LIMITS.rows;
      data = relevant.sort((a, b) => stamp(a.occurred_at) - stamp(b.occurred_at)).slice(-maximum).map((row) => ({
        entity_id: row.entity_id, occurred_at: new Date(stamp(row.occurred_at)).toISOString(),
        ...(request.action === "read_command_results" ? { status: ["succeeded", "failed", "rejected", "expired", "unknown"].includes(row.status) ? row.status : "unknown", error_code: safeCode(row.error_code) } : { level: ["debug", "info", "warning", "error"].includes(row.level) ? row.level : "info", event_code: safeCode(row.event_code) })
      }));
    }
    // Recheck expiry/revocation immediately before releasing the bounded report.
    this.authorizeRequest(request, context);
    const report = { schema_version: 1, ...authorization, observed_at: new Date(observed).toISOString(), redaction: "allowlisted_structured_fields_only", data };
    if (Buffer.byteLength(JSON.stringify(report)) > SUPPORT_LIMITS.reportBytes) deny("diagnostic_report_too_large");
    this.#grants.get(request.grant_id).requests += 1;
    return report;
  }
}
