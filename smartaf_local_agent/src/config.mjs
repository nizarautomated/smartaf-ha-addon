import { compileAccessPolicy } from './access-policy.mjs';
import { loadSupportConsentConfig } from './support-consent-config.mjs';
const HOME_ID_PATTERN = /^home_[a-z0-9_]{3,48}$/;
const AGENT_ID_PATTERN = /^agent_[a-z0-9_]{3,64}$/;

export const DEFAULT_ALLOWED_SERVICES = Object.freeze([
  "button.press",
  "climate.set_temperature",
  "cover.close_cover",
  "cover.open_cover",
  "cover.set_cover_position",
  "homeassistant.turn_off",
  "input_boolean.toggle",
  "input_boolean.turn_off",
  "input_boolean.turn_on",
  "light.toggle",
  "light.turn_off",
  "light.turn_on",
  "media_player.media_pause",
  "media_player.media_play",
  "media_player.media_stop",
  "media_player.play_media",
  "media_player.turn_off",
  "media_player.turn_on",
  "media_player.volume_set",
  "notify.send_message",
  "remote.turn_off",
  "remote.turn_on",
  "scene.create",
  "scene.turn_on",
  "switch.toggle",
  "switch.turn_off",
  "switch.turn_on",
  "vacuum.return_to_base",
  "vacuum.start"
]);

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`${name} is verplicht`);
  return value;
}

function integer(env, name, fallback, minimum, maximum) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is ongeldig`);
  return value;
}

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function loadConfig(env = process.env) {
  const homeId = required(env, "SMARTAF_HOME_ID");
  const agentId = required(env, "SMARTAF_AGENT_ID");
  const token = required(env, "SMARTAF_AGENT_TOKEN");
  if (!HOME_ID_PATTERN.test(homeId)) throw new Error("SMARTAF_HOME_ID is ongeldig");
  if (!AGENT_ID_PATTERN.test(agentId)) throw new Error("SMARTAF_AGENT_ID is ongeldig");
  if (token.length < 32) throw new Error("SMARTAF_AGENT_TOKEN moet minimaal 32 tekens bevatten");

  const allowInsecure = enabled(env.SMARTAF_ALLOW_INSECURE_HTTP);
  const controlPlaneUrl = new URL(required(env, "SMARTAF_CONTROL_PLANE_URL"));
  if (controlPlaneUrl.protocol !== "https:" && !(allowInsecure && controlPlaneUrl.protocol === "http:")) {
    throw new Error("SMARTAF_CONTROL_PLANE_URL moet HTTPS gebruiken");
  }
  controlPlaneUrl.pathname = controlPlaneUrl.pathname.replace(/\/$/, "");

  const haWebSocketUrl = new URL(env.SMARTAF_HA_WEBSOCKET_URL || "ws://supervisor/core/websocket");
  if (!["ws:", "wss:"].includes(haWebSocketUrl.protocol)) throw new Error("SMARTAF_HA_WEBSOCKET_URL moet ws of wss gebruiken");
  const haToken = required(env, "SUPERVISOR_TOKEN");
  const allowedServices = new Set(
    String(env.SMARTAF_ALLOWED_SERVICES || DEFAULT_ALLOWED_SERVICES.join(","))
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );

  return {
    homeId,
    agentId,
    token,
    controlPlaneUrl: controlPlaneUrl.toString().replace(/\/$/, ""),
    haWebSocketUrl: haWebSocketUrl.toString(),
    haToken,
    dataDir: env.SMARTAF_DATA_DIR || "/data",
    agentVersion: env.SMARTAF_AGENT_VERSION || "0.1.0",
    allowedServices,
    accessPolicy: compileAccessPolicy(env.SMARTAF_ACCESS_POLICY_JSON?.trim() ? JSON.parse(env.SMARTAF_ACCESS_POLICY_JSON) : null, {homeId}),
    supportConsent: loadSupportConsentConfig(env.SMARTAF_SUPPORT_CONSENT_JSON, { secureTransport: controlPlaneUrl.protocol === 'https:' }),
    pollIntervalMs: integer(env, "SMARTAF_POLL_INTERVAL_MS", 500, 100, 60_000),
    heartbeatIntervalMs: integer(env, "SMARTAF_HEARTBEAT_INTERVAL_MS", 30_000, 5_000, 300_000),
    reconnectMinimumMs: integer(env, "SMARTAF_RECONNECT_MINIMUM_MS", 1_000, 100, 60_000),
    reconnectMaximumMs: integer(env, "SMARTAF_RECONNECT_MAXIMUM_MS", 30_000, 1_000, 300_000),
    eventQueueLimit: integer(env, "SMARTAF_EVENT_QUEUE_LIMIT", 5_000, 100, 100_000)
  };
}
