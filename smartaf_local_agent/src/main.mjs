import { loadConfig } from "./config.mjs";
import { DurableAgentState } from "./durable-state.mjs";
import { HomeAssistantWebSocketClient } from "./ha-client.mjs";
import { acknowledgement, eventFromHomeAssistant, serviceCallFromCommand, stateSnapshotFromHomeAssistant, validateServerCommand } from "./protocol.mjs";
import { SmartAFServerClient } from "./server-client.mjs";

const config = loadConfig();
// This stays below the server's completed-event replay window (256). A crash
// before the batch checkpoint can therefore only replay safely cached events.
const EVENT_FLUSH_BATCH_SIZE = 100;
const EVENT_BUFFER_RESUME_RATIO = 0.5;
const state = await new DurableAgentState({ dataDir: config.dataDir, eventQueueLimit: config.eventQueueLimit }).init();
const server = new SmartAFServerClient({
  baseUrl: config.controlPlaneUrl,
  homeId: config.homeId,
  agentId: config.agentId,
  token: config.token
});

let stopping = false;
let ha = null;
let reconnectMs = config.reconnectMinimumMs;
let serverInstanceId = null;
let snapshotInProgress = null;
let haBackpressure = false;

function log(event, details = {}) {
  console.log(JSON.stringify({ occurred_at: new Date().toISOString(), event, home_id: config.homeId, agent_id: config.agentId, ...details }));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function enqueueStateSnapshot(client, reason) {
  if (snapshotInProgress) return snapshotInProgress;
  snapshotInProgress = (async () => {
    const states = await client.getStates();
    if (!Array.isArray(states)) throw Object.assign(new Error("Home Assistant gaf geen statelijst"), { code: "ha_invalid_states" });
    const snapshot = stateSnapshotFromHomeAssistant({
      homeId: config.homeId,
      agentId: config.agentId,
      states
    });
    await state.enqueueSequencedEvent(snapshot);
    log("ha_state_snapshot_buffered", { reason, state_count: snapshot.payload.states.length });
  })().finally(() => {
    snapshotInProgress = null;
  });
  return snapshotInProgress;
}

async function waitForHomeAssistantBufferCapacity() {
  if (!haBackpressure) return;
  const resumeAt = Math.floor(config.eventQueueLimit * EVENT_BUFFER_RESUME_RATIO);
  let bufferedEvents = await state.bufferedEvents();
  log("ha_backpressure_wait", { buffered_events: bufferedEvents, resume_at: resumeAt });
  while (!stopping && bufferedEvents > resumeAt) {
    await wait(1_000);
    bufferedEvents = await state.bufferedEvents();
  }
  if (!stopping) log("ha_backpressure_released", { buffered_events: bufferedEvents, resume_at: resumeAt });
  haBackpressure = false;
}

async function connectHomeAssistant() {
  while (!stopping) {
    let candidate = null;
    try {
      await waitForHomeAssistantBufferCapacity();
      if (stopping) break;
      candidate = new HomeAssistantWebSocketClient({ url: config.haWebSocketUrl, token: config.haToken });
      candidate.onError = (error) => {
        log("ha_subscription_error", { code: error.code || "unknown" });
        if (error.code === "event_buffer_full") {
          haBackpressure = true;
          candidate.close();
        }
      };
      await candidate.connect();
      candidate.onClose = () => {
        if (ha === candidate) ha = null;
      };
      const enqueueHomeAssistantEvent = async (event) => {
        const envelope = eventFromHomeAssistant({ homeId: config.homeId, agentId: config.agentId, event });
        if (envelope) await state.enqueueSequencedEvent(envelope);
      };
      await candidate.subscribeStateChanges(enqueueHomeAssistantEvent);
      await candidate.subscribeEvent("call_service", enqueueHomeAssistantEvent);
      ha = candidate;
      reconnectMs = config.reconnectMinimumMs;
      log("ha_connected");
      await enqueueStateSnapshot(candidate, "ha_connect");
      while (!stopping && ha === candidate && candidate.connected) await wait(500);
    } catch (error) {
      if (ha === candidate) ha = null;
      if (error.code === "event_buffer_full") haBackpressure = true;
      candidate?.close();
      log("ha_connect_failed", { code: error.code || "unknown", retry_ms: reconnectMs });
    }
    if (!stopping) {
      await wait(reconnectMs);
      reconnectMs = Math.min(config.reconnectMaximumMs, reconnectMs * 2);
    }
  }
}

async function flushEvents() {
  while (!stopping) {
    const events = await state.firstEvents(EVENT_FLUSH_BATCH_SIZE);
    if (events.length === 0) {
      await wait(100);
      continue;
    }
    const deliveredEventIds = [];
    let deliveryError = null;
    for (const event of events) {
      try {
        await server.sendEvent(event);
        deliveredEventIds.push(event.event_id);
      } catch (error) {
        deliveryError = error;
        break;
      }
    }
    try {
      if (deliveredEventIds.length > 0) await state.removeEvents(deliveredEventIds);
    } catch (error) {
      deliveryError ||= error;
    }
    if (deliveryError) {
      log("event_delivery_failed", { code: deliveryError.code || "unknown" });
      await wait(1_000);
    }
  }
}

async function acknowledgeRecorded(command, recorded) {
  const status = recorded.status === "executing" ? "failed" : recorded.status;
  const errorCode = recorded.status === "executing" ? "execution_outcome_unknown" : recorded.error_code;
  await server.acknowledge(acknowledgement(command, config.agentId, status, { errorCode, latencyMs: recorded.latency_ms }));
}

async function executeCommand(rawCommand) {
  const previous = await state.commandResult(rawCommand.command_id);
  if (previous) {
    await acknowledgeRecorded(rawCommand, previous);
    return;
  }
  let command;
  try {
    command = validateServerCommand(rawCommand, { homeId: config.homeId, agentId: config.agentId, allowedServices: config.allowedServices });
  } catch (error) {
    if (typeof rawCommand.command_id === "string") {
      const status = error.details?.some((detail) => detail.path === "expires_at" && detail.message === "is verlopen") ? "expired" : "rejected";
      await server.acknowledge(acknowledgement(rawCommand, config.agentId, status, { errorCode: error.code || "invalid_command" }));
    }
    return;
  }
  if (!ha?.connected) return;
  const started = performance.now();
  await state.recordCommandResult({ command_id: command.command_id, status: "executing", occurred_at: new Date().toISOString() });
  try {
    await ha.callService(serviceCallFromCommand(command));
    const result = { command_id: command.command_id, status: "succeeded", occurred_at: new Date().toISOString(), latency_ms: Number((performance.now() - started).toFixed(3)) };
    await state.recordCommandResult(result);
    await acknowledgeRecorded(command, result);
  } catch (error) {
    const result = { command_id: command.command_id, status: "failed", occurred_at: new Date().toISOString(), error_code: error.code || "ha_call_failed", latency_ms: Number((performance.now() - started).toFixed(3)) };
    await state.recordCommandResult(result);
    await acknowledgeRecorded(command, result);
  }
}

async function pollCommands() {
  while (!stopping) {
    try {
      if (ha?.connected) {
        const commands = await server.claimCommands();
        for (const command of commands) await executeCommand(command);
      }
    } catch (error) {
      log("command_poll_failed", { code: error.code || "unknown" });
    }
    await wait(config.pollIntervalMs);
  }
}

async function heartbeat() {
  while (!stopping) {
    try {
      const response = await server.heartbeat({
        protocol_version: 1,
        agent_id: config.agentId,
        agent_version: config.agentVersion,
        connection_state: ha?.connected ? "online" : "ha_disconnected",
        buffered_events: await state.bufferedEvents(),
        capabilities: ["state_events", "state_snapshots", "service_observations", "commands", "acknowledgements", "durable_buffer", "no_automation_logic"]
      });
      if (typeof response.server_instance_id === "string") {
        if (serverInstanceId && serverInstanceId !== response.server_instance_id && ha?.connected) await enqueueStateSnapshot(ha, "control_plane_restart");
        serverInstanceId = response.server_instance_id;
      }
    } catch (error) {
      log("heartbeat_failed", { code: error.code || "unknown" });
    }
    await wait(config.heartbeatIntervalMs);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    ha?.close();
  });
}

log("local_agent_started", { version: config.agentVersion });
await Promise.all([connectHomeAssistant(), flushEvents(), pollCommands(), heartbeat()]);
