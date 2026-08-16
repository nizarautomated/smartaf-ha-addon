import test from "node:test";
import assert from "node:assert/strict";
import { eventFromHomeAssistant, stateSnapshotFromHomeAssistant, validateServerCommand } from "../src/protocol.mjs";

test("state-event bevat geen attributen", () => {
  const event = eventFromHomeAssistant({
    homeId: "home_green_test_001",
    agentId: "agent_green_test_001",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-16T10:00:00.000Z",
      data: { entity_id: "binary_sensor.motion", old_state: { state: "off" }, new_state: { state: "on", attributes: { secret: "ignored" } } }
    }
  });
  assert.equal(event.new_state, "on");
  assert.equal(JSON.stringify(event).includes("secret"), false);
});

test("command voor andere woning of niet-toegestane service wordt geweigerd", () => {
  const command = {
    protocol_version: 1,
    command_id: "cmd_123e4567-e89b-12d3-a456-426614174000",
    home_id: "home_green_test_001",
    not_before: "2026-08-16T10:00:00.000Z",
    expires_at: "2026-08-16T10:01:00.000Z",
    type: "call_service",
    service: "light.turn_on",
    entity_id: "light.keuken",
    data: {}
  };
  const options = { homeId: "home_green_test_001", agentId: "agent_green_test_001", allowedServices: new Set(["light.turn_on"]), now: Date.parse("2026-08-16T10:00:30.000Z") };
  assert.equal(validateServerCommand(command, options).service, "light.turn_on");
  assert.throws(() => validateServerCommand({ ...command, home_id: "home_other_001" }, options), /geweigerd/);
  assert.throws(() => validateServerCommand({ ...command, service: "shell_command.run" }, options), /geweigerd/);
});

test("snapshot is één begrensd event zonder attributen", () => {
  const event = stateSnapshotFromHomeAssistant({
    homeId: "home_green_test_001",
    agentId: "agent_green_test_001",
    states: [{ entity_id: "light.keuken", state: "on", attributes: { secret: "ignored" } }],
    capturedAt: "2026-08-16T10:00:00.000Z"
  });
  assert.deepEqual(event.payload.states, [{ entity_id: "light.keuken", state: "on" }]);
  assert.equal(JSON.stringify(event).includes("secret"), false);
});
