const HOME_ID_PATTERN = /^home_[a-z0-9_]{3,48}$/;
const AGENT_ID_PATTERN = /^agent_[a-z0-9_]{3,64}$/;

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

export function loadConfig(env = process.env) {
  const homeId = required(env, "SMARTAF_HOME_ID");
  const agentId = required(env, "SMARTAF_AGENT_ID");
  const token = required(env, "SMARTAF_AGENT_TOKEN");
  if (!HOME_ID_PATTERN.test(homeId)) throw new Error("SMARTAF_HOME_ID is ongeldig");
  if (!AGENT_ID_PATTERN.test(agentId)) throw new Error("SMARTAF_AGENT_ID is ongeldig");
  if (token.length < 32) throw new Error("SMARTAF_AGENT_TOKEN moet minimaal 32 tekens bevatten");
  const controlPlaneUrl = new URL(required(env, "SMARTAF_CONTROL_PLANE_URL"));
  if (controlPlaneUrl.protocol !== "https:") throw new Error("SMARTAF_CONTROL_PLANE_URL moet HTTPS gebruiken");
  controlPlaneUrl.pathname = controlPlaneUrl.pathname.replace(/\/$/, "");
  const haWebSocketUrl = new URL(env.SMARTAF_HA_WEBSOCKET_URL || "ws://supervisor/core/websocket");
  if (!["ws:", "wss:"].includes(haWebSocketUrl.protocol)) throw new Error("SMARTAF_HA_WEBSOCKET_URL moet ws of wss gebruiken");
  const haToken = required(env, "SUPERVISOR_TOKEN");
  const allowedServices = new Set(required(env, "SMARTAF_ALLOWED_SERVICES").split(",").map((item) => item.trim()).filter(Boolean));
  return {
    homeId,
    agentId,
    token,
    controlPlaneUrl: controlPlaneUrl.toString().replace(/\/$/, ""),
    haWebSocketUrl: haWebSocketUrl.toString(),
    haToken,
    dataDir: env.SMARTAF_DATA_DIR || "/data",
    agentVersion: env.SMARTAF_AGENT_VERSION || "0.0.0",
    allowedServices,
    pollIntervalMs: integer(env, "SMARTAF_POLL_INTERVAL_MS", 500, 100, 60_000),
    heartbeatIntervalMs: integer(env, "SMARTAF_HEARTBEAT_INTERVAL_MS", 30_000, 5_000, 300_000),
    eventQueueLimit: integer(env, "SMARTAF_EVENT_QUEUE_LIMIT", 5_000, 100, 100_000),
    reconnectMinimumMs: 1_000,
    reconnectMaximumMs: 30_000
  };
}
