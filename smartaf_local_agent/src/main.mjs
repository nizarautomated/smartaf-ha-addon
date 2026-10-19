import { loadConfig } from "./config.mjs";
import { selectTelemetry } from './access-policy.mjs';
import { enforceLocalPolicy } from './policy-runtime.mjs';
import { assertCommandReady } from "./command-guard.mjs";
import { DurableAgentState } from "./durable-state.mjs";
import { HomeAssistantWebSocketClient, subscribeHomeAssistantObservations } from "./ha-client.mjs";
import { acknowledgeCommandResult, executeCommandAttempt } from './command-execution.mjs';
import { acknowledgement, eventFromHomeAssistant, serviceCallFromCommand, stateSnapshotFromHomeAssistant, validateServerCommand } from "./protocol.mjs";
import { SmartAFServerClient } from "./server-client.mjs";
import { SupportConsentController } from './support-consent.mjs';
import { createSupportConsentServer } from './support-consent-server.mjs';
import { SupportAgentTransport, SupportDiagnosticJournal } from './support-agent-transport.mjs';

const config = loadConfig();
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
let supportController = null, supportTransport = null, supportUiServer = null;
const supportJournal = config.supportConsent.enabled ? new SupportDiagnosticJournal() : null;

function log(event, details = {}) {
  console.log(JSON.stringify({ occurred_at: new Date().toISOString(), event, home_id: config.homeId, agent_id: config.agentId, ...details }));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function closeSupport() {
  try { supportTransport?.close(); } catch { /* A clock failure already closes local support. */ }
}

async function startSupport() {
  if (config.supportConsent.errorCode) log('support_disabled', { code: config.supportConsent.errorCode });
  if (!config.supportConsent.enabled) return;
  try {
    supportController = new SupportConsentController({ homeId: config.homeId, policy: config.accessPolicy, allowedOrigins: config.supportConsent.allowedOrigins, allowedConsentUsers: config.supportConsent.allowedConsentUsers });
    supportUiServer = createSupportConsentServer({ controller: supportController });
    await new Promise((resolve, reject) => { supportUiServer.once('error', reject); supportUiServer.listen(config.supportConsent.port, '0.0.0.0', resolve); });
    supportUiServer.on('error', () => { closeSupport(); supportUiServer.close(); supportTransport = null; log('support_disabled', { code: 'support_listener_failed' }); });
    if (config.accessPolicy?.enabled && config.accessPolicy.support.enabled) {
      supportTransport = new SupportAgentTransport({ homeId: config.homeId, policyRevision: config.accessPolicy.revision, controller: supportController, client: server,
        connectionState: async () => ({ haConnected: ha?.connected === true, bufferedEvents: await state.bufferedEvents() }),
        collect: async request => {
          const client = ha, observedAt = new Date().toISOString();
          if (!client?.connected) throw Object.assign(new Error('HA disconnected'), {code:'ha_disconnected'});
          if (request.action === 'read_health') return { observed_at: observedAt, agent: { connected: true, version: config.agentVersion, buffered_events: await state.bufferedEvents() }, ha: { connected: true } };
          if (request.action === 'read_entity_availability') {
            const all = await client.getStates();
            if (ha !== client || !client.connected || !Array.isArray(all)) throw Object.assign(new Error('HA changed'), {code:'ha_disconnected'});
            return { observed_at: new Date().toISOString(), states: all.filter(item => request.entities.includes(item?.entity_id)).map(item => ({ entity_id: item.entity_id, state: item.state })) };
          }
          return supportJournal.collect(request, observedAt);
        }
      });
    }
  } catch {
    closeSupport(); supportTransport = null; supportUiServer?.close(); supportUiServer = null;
    log('support_disabled', { code: 'support_start_failed' });
  }
}

async function pollSupport() {
  if (!supportTransport) return;
  while (!stopping && supportTransport) {
    await supportTransport.step();
    await wait(2_000);
  }
}

async function enqueueStateSnapshot(client, reason) {
  if (snapshotInProgress) return snapshotInProgress;
  snapshotInProgress = (async () => {
    const states = await client.getStates();
    if (!Array.isArray(states)) throw Object.assign(new Error("Home Assistant gaf geen statelijst"), { code: "ha_invalid_states" });
    const snapshot = selectTelemetry(stateSnapshotFromHomeAssistant({
      homeId: config.homeId,
      agentId: config.agentId,
      states
    }), {policy:config.accessPolicy,homeId:config.homeId});
    if (!snapshot) return;
    await state.enqueueSequencedEvent(snapshot);
    log("ha_state_snapshot_buffered", { reason, state_count: snapshot.payload.states.length });
  })().finally(() => {
    snapshotInProgress = null;
  });
  return snapshotInProgress;
}

async function connectHomeAssistant() {
  while (!stopping) {
    let candidate = null;
    try {
      candidate = new HomeAssistantWebSocketClient({ url: config.haWebSocketUrl, token: config.haToken });
      candidate.onError = (error) => {
        log("ha_subscription_error", { code: error.code || "unknown" });
        if (error.code === "event_buffer_full") candidate.close();
      };
      await candidate.connect();
      candidate.onClose = () => {
        if (ha === candidate) { ha = null; closeSupport(); }
      };
      const enqueueHomeAssistantEvent = async (event) => {
        const rawEnvelope = eventFromHomeAssistant({ homeId: config.homeId, agentId: config.agentId, sequence: 0, event });
        const envelope = rawEnvelope && selectTelemetry(rawEnvelope,{policy:config.accessPolicy,homeId:config.homeId});
        if (!envelope) return;
        await state.enqueueSequencedEvent(envelope);
      };
      const observations=await subscribeHomeAssistantObservations(candidate,enqueueHomeAssistantEvent);
      candidate.serviceObservationsAvailable=observations.service_observations;
      if(!observations.service_observations)log('ha_service_observations_unavailable',{code:'ha_permission_denied'});
      ha = candidate;
      reconnectMs = config.reconnectMinimumMs;
      log("ha_connected");
      await enqueueStateSnapshot(candidate, "ha_connect");
      while (!stopping && ha === candidate && candidate.connected) await wait(500);
    } catch (error) {
      if (ha === candidate) ha = null;
      closeSupport();
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
    const event = await state.firstEvent();
    if (!event) {
      await wait(100);
      continue;
    }
    try {
      const selected=selectTelemetry(event,{policy:config.accessPolicy,homeId:config.homeId});
      if (selected) await server.sendEvent(selected);
      await state.removeEvent(event.event_id);
    } catch (error) {
      closeSupport();
      log("event_delivery_failed", { code: error.code || "unknown" });
      await wait(1_000);
    }
  }
}

async function acknowledgeRecorded(command, recorded) {
  return acknowledgeCommandResult(command,recorded,{agentId:config.agentId,acknowledge:value=>server.acknowledge(value)});
}

async function executeCommand(rawCommand) {
  const previous = await state.commandResult(rawCommand.command_id);
  if (previous) {
    await acknowledgeRecorded(rawCommand, previous);
    return;
  }
  let command;
  try {
    command = validateServerCommand(rawCommand, {
      homeId: config.homeId,
      agentId: config.agentId,
      allowedServices: config.allowedServices
    });
  } catch (error) {
    if (typeof rawCommand.command_id === "string") {
      const status = error.details?.some((detail) => detail.path === "expires_at" && detail.message === "is verlopen") ? "expired" : "rejected";
      await server.acknowledge(acknowledgement(rawCommand, config.agentId, status, { errorCode: error.code || "invalid_command" }));
    }
    return;
  }
  const client = ha;
  const result=await executeCommandAttempt(command,{
    recordResult:async value=>{ await state.recordCommandResult(value); supportJournal?.record(command.entity_id, value); },
    perform:async()=>{
      await enforceLocalPolicy(command,{policy:config.accessPolicy,homeId:config.homeId,client,isCurrentClient:candidate=>ha===candidate});
      await assertCommandReady(command,{client,isCurrentClient:candidate=>ha===candidate});
      return client.callService(serviceCallFromCommand(command));
    }
  });
  await acknowledgeRecorded(command,result);
}

async function pollCommands() {
  while (!stopping) {
    try {
      if (ha?.connected) {
        const commands = await server.claimCommands();
        for (const command of commands) await executeCommand(command);
      }
    } catch (error) {
      closeSupport();
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
        capabilities: ["state_events", ...(ha?.serviceObservationsAvailable?['service_observations']:[]), "commands", "acknowledgements", "durable_buffer", "no_automation_logic", "command_guards_v1", "state_metadata_v1", "own_command_context_v1", ...(config.accessPolicy ? ['local_access_policy_v1'] : [])]
      });
      if (typeof response.server_instance_id === "string") {
        if (serverInstanceId && serverInstanceId !== response.server_instance_id && ha?.connected) {
          closeSupport();
          await enqueueStateSnapshot(ha, "control_plane_restart");
        }
        serverInstanceId = response.server_instance_id;
      }
    } catch (error) {
      closeSupport();
      log("heartbeat_failed", { code: error.code || "unknown" });
    }
    await wait(config.heartbeatIntervalMs);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    closeSupport(); supportUiServer?.close();
    ha?.close();
  });
}

log("local_agent_started", { version: config.agentVersion });
await startSupport();
await Promise.all([connectHomeAssistant(), flushEvents(), pollCommands(), heartbeat(), pollSupport()]);
