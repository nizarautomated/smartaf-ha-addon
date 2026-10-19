import test from "node:test";
import assert from "node:assert/strict";
import { assertCommandReady } from "../src/command-guard.mjs";
import { validateServerCommand } from "../src/protocol.mjs";

const NOW = Date.parse("2026-10-19T10:00:10Z");
const command = {
  protocol_version: 1, command_id: "cmd_123e4567-e89b-12d3-a456-426614174000",
  home_id: "home_green_test_001", type: "call_service", service: "light.turn_off",
  entity_id: "light.keuken", data: {}, issued_at: "2026-10-19T10:00:00Z",
  not_before: "2026-10-19T10:00:10Z", expires_at: "2026-10-19T10:00:40Z",
  guard: {
    type: "state_equals", entity_id: "binary_sensor.motion_keuken", state: "off",
    source_event_id: "evt_motion_clear_001", observed_at: "2026-10-19T10:00:00Z"
  }
};
const validation = {
  homeId: command.home_id, agentId: "agent_green_test_001",
  allowedServices: new Set([command.service]), now: NOW
};
const sensor = { entity_id: command.guard.entity_id, state: "off", last_changed: command.guard.observed_at };

function clientFixture(states = [sensor]) {
  return { connected: true, calls: 0, getStates: async () => states, callService() { this.calls += 1; } };
}

async function attempt(input, client, options = {}) {
  const checked = validateServerCommand(input, validation);
  await assertCommandReady(checked, { client, clock: () => NOW, ...options });
  client.callService();
}

test("een onveranderde sensor staat een verlopen wachttijd toe zonder states door te sturen", async () => {
  const client = clientFixture([sensor, { entity_id: "person.private", state: "home", attributes: { private: "not exported" } }]);
  await attempt(command, client);
  assert.equal(client.calls, 1);
});

test("oude commanden zonder guard blijven ondersteund en lezen geen states", async () => {
  const { guard, ...legacy } = command;
  const client = clientFixture();
  client.getStates = () => { throw new Error("must not read"); };
  await attempt(legacy, client);
  assert.equal(client.calls, 1);
});

test("beweging, ontbrekende en onbeschikbare sensor blokkeren de servicecall", async () => {
  for (const [states, reason] of [
    [[{ ...sensor, state: "on" }], "guard_condition_changed"],
    [[], "guard_state_missing"],
    [[{ ...sensor, state: "unavailable" }], "guard_state_unavailable"],
    [[{ ...sensor, state: "unknown" }], "guard_state_unavailable"],
    [[{ ...sensor, last_changed: undefined }], "guard_state_unavailable"],
    [null, "guard_state_unavailable"]
  ]) {
    const client = clientFixture(states);
    await assert.rejects(attempt(command, client), (error) => error.safetyRejection && error.code === reason);
    assert.equal(client.calls, 0);
  }
});

test("off-on-off na de brongebeurtenis mag de oorspronkelijke timer niet uitvoeren", async () => {
  const client = clientFixture([{ ...sensor, last_changed: "2026-10-19T10:00:09Z" }]);
  await assert.rejects(attempt(command, client), { code: "guard_observation_superseded" });
  assert.equal(client.calls, 0);
});

test("HA disconnect voor of tijdens de guardcheck en vervangen verbinding zijn failclosed", async () => {
  const offline = clientFixture();
  offline.connected = false;
  await assert.rejects(attempt(command, offline), { code: "ha_disconnected" });
  assert.equal(offline.calls, 0);
  const disconnecting = clientFixture();
  disconnecting.getStates = async () => { disconnecting.connected = false; return [sensor]; };
  await assert.rejects(attempt(command, disconnecting), { code: "ha_disconnected" });
  assert.equal(disconnecting.calls, 0);
  const replaced = clientFixture();
  let current = true;
  replaced.getStates = async () => { current = false; return [sensor]; };
  await assert.rejects(attempt(command, replaced, { isCurrentClient: () => current }), { code: "ha_connection_changed" });
  assert.equal(replaced.calls, 0);
});

test("een mislukte of hangende statecheck geeft geen fysieke opdracht", async () => {
  const failed = clientFixture();
  failed.getStates = async () => { throw new Error("failed"); };
  await assert.rejects(attempt(command, failed), { code: "guard_state_unavailable" });
  assert.equal(failed.calls, 0);
  const hanging = clientFixture();
  hanging.getStates = () => new Promise(() => {});
  await assert.rejects(attempt(command, hanging, { readTimeoutMs: 5 }), { code: "guard_state_unavailable" });
  assert.equal(hanging.calls, 0);
});

test("lokale agent accepteert geen vroege, verlopen of beschadigde guard-opdracht", () => {
  assert.throws(() => validateServerCommand(command, { ...validation, now: NOW - 1 }), (error) => error.details.some((detail) => detail.path === "not_before"));
  assert.throws(() => validateServerCommand(command, { ...validation, now: NOW + 30_000 }), (error) => error.details.some((detail) => detail.path === "expires_at"));
  for (const guard of [null, {}, { ...command.guard, type: "run_code" }, { ...command.guard, state: "unknown" }, { ...command.guard, observed_at: "invalid" }]) {
    assert.throws(() => validateServerCommand({ ...command, guard }, validation), /geweigerd/);
  }
});

test("TTL wordt opnieuw gecontroleerd na het ophalen van de sensorstate", async () => {
  const client = clientFixture();
  let now = NOW;
  client.getStates = async () => { now += 31_000; return [sensor]; };
  await assert.rejects(attempt(command, client, { clock: () => now }), { code: "command_expired" });
  assert.equal(client.calls, 0);
});
