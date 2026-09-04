import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableAgentState } from "../src/durable-state.mjs";

test("buffer, sequence en commandresultaat overleven restart", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smartaf-agent-app-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const state = await new DurableAgentState({ dataDir }).init();
  const [event] = await state.enqueueSequencedEvents([{ event_id: "evt_test_001" }]);
  await state.recordCommandResult({ command_id: "cmd_test_001", status: "succeeded" });
  const restarted = await new DurableAgentState({ dataDir }).init();
  assert.equal(event.sequence, 1);
  assert.equal((await restarted.firstEvent()).event_id, "evt_test_001");
  assert.equal((await restarted.commandResult("cmd_test_001")).status, "succeeded");
});

test("batchverwijdering bewaart volgorde en resterende events na restart", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smartaf-agent-app-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const state = await new DurableAgentState({ dataDir }).init();
  const events = await state.enqueueSequencedEvents([
    { event_id: "evt_batch_001" },
    { event_id: "evt_batch_002" },
    { event_id: "evt_batch_003" }
  ]);
  assert.deepEqual((await state.firstEvents(2)).map((event) => event.event_id), ["evt_batch_001", "evt_batch_002"]);
  assert.equal(await state.removeEvents(events.slice(0, 2).map((event) => event.event_id)), 1);

  const restarted = await new DurableAgentState({ dataDir }).init();
  assert.equal(await restarted.bufferedEvents(), 1);
  assert.equal((await restarted.firstEvent()).event_id, "evt_batch_003");
  assert.equal((await restarted.firstEvent()).sequence, 3);
});
