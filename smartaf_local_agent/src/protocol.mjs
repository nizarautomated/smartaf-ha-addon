import { randomUUID } from "node:crypto";

const ENTITY_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;
const COMMAND_ID_PATTERN = /^cmd_[a-f0-9-]{36}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function eventFromHomeAssistant({ homeId, agentId, event }) {
  if (!isObject(event) || !isObject(event.data)) return null;
  const occurredAt = Date.parse(event.time_fired);
  const envelope = {
    protocol_version: 1,
    home_id: homeId,
    agent_id: agentId,
    event_id: `evt_${randomUUID()}`,
    sequence: 0,
    occurred_at: Number.isFinite(occurredAt) ? new Date(occurredAt).toISOString() : new Date().toISOString()
  };
  if (event.event_type === "call_service") {
    const domain = event.data.domain;
    const service = event.data.service;
    if (typeof domain !== "string" || typeof service !== "string" || !/^[a-z_]+$/.test(domain) || !/^[a-z_]+$/.test(service)) return null;
    const rawTargets = event.data.service_data?.entity_id ?? event.data.target?.entity_id ?? [];
    const entityIds = (Array.isArray(rawTargets) ? rawTargets : [rawTargets])
      .filter((entityId) => typeof entityId === "string" && ENTITY_ID_PATTERN.test(entityId))
      .slice(0, 64);
    return { ...envelope, type: "event", event_type: "call_service", payload: { service: `${domain}.${service}`, entity_ids: entityIds } };
  }
  if (event.event_type !== "state_changed") return null;
  const entityId = event.data.entity_id;
  const newState = event.data.new_state?.state;
  const oldState = event.data.old_state?.state ?? null;
  if (typeof entityId !== "string" || !ENTITY_ID_PATTERN.test(entityId) || typeof newState !== "string") return null;
  return {
    ...envelope,
    type: "state_changed",
    entity_id: entityId,
    old_state: oldState === null ? null : String(oldState).slice(0, 128),
    new_state: String(newState).slice(0, 128)
  };
}

export function stateSnapshotFromHomeAssistant({ homeId, agentId, states, capturedAt = new Date().toISOString() }) {
  if (!Array.isArray(states)) throw new Error("Home Assistant-states moeten een lijst zijn");
  const sanitized = states
    .filter((item) => isObject(item) && typeof item.entity_id === "string" && ENTITY_ID_PATTERN.test(item.entity_id) && typeof item.state === "string")
    .slice(0, 5_000)
    .map((item) => ({ entity_id: item.entity_id, state: item.state.slice(0, 128) }));
  return {
    protocol_version: 1,
    home_id: homeId,
    agent_id: agentId,
    event_id: `evt_${randomUUID()}`,
    sequence: 0,
    occurred_at: new Date(capturedAt).toISOString(),
    type: "state_snapshot",
    payload: { states: sanitized }
  };
}

export function validateServerCommand(input, { homeId, agentId, allowedServices, now = Date.now() }) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!isObject(input)) throw Object.assign(new Error("Command moet een JSON-object zijn"), { code: "invalid_command" });
  if (input.protocol_version !== 1) add("protocol_version", "moet 1 zijn");
  if (input.home_id !== homeId) add("home_id", "komt niet overeen met deze woning");
  if (input.agent_id && input.agent_id !== agentId) add("agent_id", "komt niet overeen met deze agent");
  if (typeof input.command_id !== "string" || !COMMAND_ID_PATTERN.test(input.command_id)) add("command_id", "is ongeldig");
  if (input.type !== "call_service") add("type", "is niet toegestaan");
  if (!allowedServices.has(input.service)) add("service", "is niet toegestaan");
  if (typeof input.entity_id !== "string" || !ENTITY_ID_PATTERN.test(input.entity_id)) add("entity_id", "is ongeldig");
  if (!isObject(input.data)) add("data", "moet een object zijn");
  const notBefore = Date.parse(input.not_before);
  const expiresAt = Date.parse(input.expires_at);
  if (!Number.isFinite(notBefore)) add("not_before", "is ongeldig");
  if (!Number.isFinite(expiresAt)) add("expires_at", "is ongeldig");
  if (Number.isFinite(expiresAt) && expiresAt <= now) add("expires_at", "is verlopen");
  if (errors.length) throw Object.assign(new Error("Servercommand is geweigerd"), { code: "invalid_command", details: errors });
  return { ...input, not_before_timestamp: notBefore, expires_at_timestamp: expiresAt };
}

export function serviceCallFromCommand(command) {
  const separator = command.service.indexOf(".");
  return {
    domain: command.service.slice(0, separator),
    service: command.service.slice(separator + 1),
    service_data: { ...command.data, entity_id: command.entity_id }
  };
}

export function acknowledgement(command, agentId, status, { errorCode, latencyMs, now = Date.now() } = {}) {
  return {
    protocol_version: 1,
    command_id: command.command_id,
    agent_id: agentId,
    status,
    occurred_at: new Date(now).toISOString(),
    ...(Number.isFinite(latencyMs) ? { latency_ms: latencyMs } : {}),
    ...(errorCode ? { error_code: String(errorCode).slice(0, 96) } : {})
  };
}
