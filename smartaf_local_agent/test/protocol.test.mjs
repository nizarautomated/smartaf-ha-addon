import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ALLOWED_SERVICES, loadConfig } from "../src/config.mjs";
import { eventFromHomeAssistant, serviceCallFromCommand, stateSnapshotFromHomeAssistant, validateServerCommand } from "../src/protocol.mjs";

const baseCommand = {
  protocol_version: 1,
  command_id: "cmd_123e4567-e89b-12d3-a456-426614174000",
  home_id: "home_green_test_001",
  trace_id: "trace_001",
  event_id: "evt_001000",
  issued_at: "2026-08-16T10:00:00.000Z",
  not_before: "2026-08-16T10:00:01.000Z",
  expires_at: "2026-08-16T10:00:30.000Z",
  type: "call_service",
  service: "light.turn_on",
  entity_id: "light.keuken_lamp",
  data: { brightness_pct: 80 }
};

test("config vereist HTTPS en valide tenantidentity", () => {
  const config = loadConfig({
    SMARTAF_HOME_ID: "home_green_test_001",
    SMARTAF_AGENT_ID: "agent_green_test_001",
    SMARTAF_AGENT_TOKEN: "x".repeat(32),
    SMARTAF_CONTROL_PLANE_URL: "https://control.smartaf.example/",
    SUPERVISOR_TOKEN: "supervisor-token"
  });
  assert.equal(config.controlPlaneUrl, "https://control.smartaf.example");
  assert.equal(config.haWebSocketUrl, "ws://supervisor/core/websocket");
  assert.equal(config.allowedServices.has("light.turn_on"), true);
  assert.throws(() => loadConfig({
    SMARTAF_HOME_ID: "home_green_test_001",
    SMARTAF_AGENT_ID: "agent_green_test_001",
    SMARTAF_AGENT_TOKEN: "x".repeat(32),
    SMARTAF_CONTROL_PLANE_URL: "http://control.smartaf.example",
    SUPERVISOR_TOKEN: "supervisor-token"
  }), /HTTPS/);
});

test("Home Assistant state_changed wordt een minimaal tenantgebonden event", () => {
  const event = eventFromHomeAssistant({
    homeId: "home_green_test_001",
    agentId: "agent_green_test_001",
    sequence: 42,
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-16T10:00:00.000Z",
      data: {
        entity_id: "binary_sensor.motion_sensor_keuken2",
        old_state: { state: "off", attributes: { ignored: true } },
        new_state: { state: "on", attributes: { ignored: true } }
      }
    }
  });
  assert.equal(event.home_id, "home_green_test_001");
  assert.equal(event.agent_id, "agent_green_test_001");
  assert.equal(event.sequence, 42);
  assert.equal(event.new_state, "on");
  assert.equal("attributes" in event, false);
});

test("Home Assistant call_service wordt zonder servicetekst of persoonsgegevens gespiegeld", () => {
  const event = eventFromHomeAssistant({
    homeId: "home_green_test_001",
    agentId: "agent_green_test_001",
    sequence: 43,
    event: {
      event_type: "call_service",
      time_fired: "2026-08-16T10:00:01.000Z",
      data: {
        domain: "light",
        service: "turn_on",
        service_data: { entity_id: ["light.keuken_lamp"], brightness_pct: 80, message: "niet meesturen" }
      }
    }
  });
  assert.equal(event.type, "event");
  assert.equal(event.event_type, "call_service");
  assert.deepEqual(event.payload, { service: "light.turn_on", entity_ids: ["light.keuken_lamp"] });
  assert.equal(JSON.stringify(event).includes("niet meesturen"), false);
});

test("statesnapshot wordt als één begrensd attribuutloos cache-event verstuurd", () => {
  const event = stateSnapshotFromHomeAssistant({
    homeId: "home_green_test_001",
    agentId: "agent_green_test_001",
    states: [
      { entity_id: "light.keuken", state: "on", attributes: { friendly_name: "niet meesturen" } },
      { entity_id: "invalid", state: "off" }
    ],
    capturedAt: "2026-08-16T10:00:00.000Z"
  });
  assert.equal(event.type, "state_snapshot");
  assert.deepEqual(event.payload.states, [{ entity_id: "light.keuken", state: "on", metadata: { restored: false } }]);
  assert.equal(JSON.stringify(event).includes("friendly_name"), false);
});

test("alleen een niet-verlopen allowlisted command voor de eigen woning wordt geaccepteerd", () => {
  const options = {
    homeId: "home_green_test_001",
    agentId: "agent_green_test_001",
    allowedServices: new Set(DEFAULT_ALLOWED_SERVICES),
    now: Date.parse("2026-08-16T10:00:02.000Z")
  };
  assert.equal(validateServerCommand(baseCommand, options).service, "light.turn_on");
  assert.throws(() => validateServerCommand({ ...baseCommand, home_id: "home_other_001" }, options), /geweigerd/);
  assert.throws(() => validateServerCommand({ ...baseCommand, service: "shell_command.run" }, options), /geweigerd/);
  assert.throws(() => validateServerCommand(baseCommand, { ...options, now: Date.parse("2026-08-16T10:00:31.000Z") }), /geweigerd/);
});

test("servicecall bevat alleen het serverdoel en begrensde data", () => {
  assert.deepEqual(serviceCallFromCommand(baseCommand), {
    domain: "light",
    service: "turn_on",
    service_data: { brightness_pct: 80, entity_id: "light.keuken_lamp" }
  });
});
