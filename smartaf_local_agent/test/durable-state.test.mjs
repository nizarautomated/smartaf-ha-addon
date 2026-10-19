import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableAgentState } from "../src/durable-state.mjs";

test("sequence, eventbuffer en commandresultaat overleven restart", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smartaf-local-agent-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const state = await new DurableAgentState({ dataDir }).init();
  assert.equal(await state.nextSequence(), 1);
  await state.enqueueEvent({ event_id: "evt_001000", sequence: 1 });
  await state.recordCommandResult({ command_id: "cmd_001", status: "succeeded" });

  const restarted = await new DurableAgentState({ dataDir }).init();
  assert.equal(await restarted.nextSequence(), 2);
  assert.equal((await restarted.firstEvent()).event_id, "evt_001000");
  assert.equal((await restarted.commandResult("cmd_001")).status, "succeeded");
  assert.equal(await restarted.removeEvent("evt_001000"), 0);
});

test("eventbuffer faalt gesloten wanneer de begrensde capaciteit bereikt is", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smartaf-local-agent-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const state = await new DurableAgentState({ dataDir, eventQueueLimit: 2 }).init();
  await state.enqueueEvent({ event_id: "evt_001000" });
  await state.enqueueEvent({ event_id: "evt_002000" });
  await assert.rejects(state.enqueueEvent({ event_id: "evt_003000" }), /Eventbuffer is vol/);
});

test("een executing command blijft na restart zichtbaar als onbekende uitkomst", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smartaf-local-agent-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const state = await new DurableAgentState({ dataDir }).init();
  await state.recordCommandResult({ command_id: "cmd_001", status: "executing" });
  const restarted = await new DurableAgentState({ dataDir }).init();
  assert.equal((await restarted.commandResult("cmd_001")).status, "executing");
});

test("statessnapshot krijgt atomisch oplopende sequences", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smartaf-local-agent-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const state = await new DurableAgentState({ dataDir }).init();
  const events = await state.enqueueSequencedEvents([
    { event_id: "evt_snapshot_001", sequence: 0 },
    { event_id: "evt_snapshot_002", sequence: 0 }
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.equal((await state.firstEvent()).sequence, 1);
  const restarted = await new DurableAgentState({ dataDir }).init();
  assert.equal(await restarted.nextSequence(), 3);
});
