import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function initial() {
  return { schema_version: 1, sequence: 0, events: [], processed_commands: [] };
}

export class DurableAgentState {
  constructor({ dataDir, eventQueueLimit = 5_000, processedCommandLimit = 2_000 } = {}) {
    this.dataDir = resolve(dataDir);
    this.path = join(this.dataDir, "agent-state.json");
    this.eventQueueLimit = eventQueueLimit;
    this.processedCommandLimit = processedCommandLimit;
    this.state = initial();
    this.lock = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const loaded = JSON.parse(await readFile(this.path, "utf8"));
      if (loaded.schema_version !== 1 || !Array.isArray(loaded.events) || !Array.isArray(loaded.processed_commands)) throw new Error("Ongeldige agent-state");
      this.state = loaded;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.#persist();
    }
    return this;
  }

  async #persist() {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
  }

  #mutate(operation) {
    const run = this.lock.catch(() => {}).then(async () => {
      const result = await operation(this.state);
      await this.#persist();
      return result;
    });
    this.lock = run;
    return run;
  }

  enqueueSequencedEvents(events) {
    if (!Array.isArray(events)) throw new Error("Events moeten een lijst zijn");
    return this.#mutate((state) => {
      if (state.events.length + events.length > this.eventQueueLimit) throw Object.assign(new Error("Eventbuffer is vol"), { code: "event_buffer_full" });
      const sequenced = events.map((event) => ({ ...event, sequence: ++state.sequence }));
      state.events.push(...sequenced);
      return structuredClone(sequenced);
    });
  }

  async enqueueSequencedEvent(event) {
    return (await this.enqueueSequencedEvents([event]))[0];
  }

  async firstEvent() {
    await this.lock.catch(() => {});
    return this.state.events[0] ? structuredClone(this.state.events[0]) : null;
  }

  removeEvent(eventId) {
    return this.#mutate((state) => {
      if (state.events[0]?.event_id === eventId) state.events.shift();
      else state.events = state.events.filter((event) => event.event_id !== eventId);
      return state.events.length;
    });
  }

  async bufferedEvents() {
    await this.lock.catch(() => {});
    return this.state.events.length;
  }

  async commandResult(commandId) {
    await this.lock.catch(() => {});
    const result = this.state.processed_commands.find((candidate) => candidate.command_id === commandId);
    return result ? structuredClone(result) : null;
  }

  recordCommandResult(result) {
    return this.#mutate((state) => {
      const existing = state.processed_commands.findIndex((candidate) => candidate.command_id === result.command_id);
      if (existing >= 0) state.processed_commands[existing] = result;
      else state.processed_commands.push(result);
      if (state.processed_commands.length > this.processedCommandLimit) state.processed_commands.splice(0, state.processed_commands.length - this.processedCommandLimit);
    });
  }
}
