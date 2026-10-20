import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
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
      if (loaded.schema_version !== 1 || !Array.isArray(loaded.events)) throw new Error("Ongeldige agent-state");
      if (!Array.isArray(loaded.processed_commands) && Array.isArray(loaded.processed_command_ids)) {
        loaded.processed_commands = loaded.processed_command_ids.map((command_id) => ({ command_id, status: "succeeded" }));
        delete loaded.processed_command_ids;
      }
      if (!Array.isArray(loaded.processed_commands)) throw new Error("Ongeldige agent-state");
      this.state = loaded;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.#persist();
    }
    return this;
  }

  async #persist(value = this.state) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file=await open(temporary,'wx',0o600);
    try {await file.writeFile(`${JSON.stringify(value)}\n`);await file.sync();} finally {await file.close();}
    await rename(temporary, this.path);
    if(process.platform!=='win32'){const directory=await open(this.dataDir,'r');try{await directory.sync();}finally{await directory.close();}}
  }

  #mutate(operation) {
    const run = this.lock.catch(() => {}).then(async () => {
      const next = structuredClone(this.state);
      const result = await operation(next);
      await this.#persist(next);
      this.state = next;
      return result;
    });
    this.lock = run;
    return run;
  }

  nextSequence() {
    return this.#mutate((state) => {
      state.sequence += 1;
      return state.sequence;
    });
  }

  enqueueEvent(event) {
    return this.#mutate((state) => {
      if (state.events.length >= this.eventQueueLimit) throw Object.assign(new Error("Eventbuffer is vol"), { code: "event_buffer_full" });
      state.events.push(event);
      return state.events.length;
    });
  }

  enqueueSequencedEvents(events,{isCurrent=()=>true}={}) {
    if (!Array.isArray(events)) throw new Error("Events moeten een lijst zijn");
    return this.#mutate((state) => {
      if(isCurrent()!==true)throw Object.assign(new Error("HA observation connection changed"),{code:"ha_disconnected"});
      if (state.events.length + events.length > this.eventQueueLimit) {
        throw Object.assign(new Error("Eventbuffer is vol"), { code: "event_buffer_full" });
      }
      const sequenced = events.map((event) => ({ ...event, sequence: ++state.sequence,
        ...(state.observer?.session_id && !state.observer.needs_reset ? {
          observer_sequence:++state.observer.produced_sequence,observer_epoch:state.observer.session_id
        }: {}) }));
      state.events.push(...sequenced);
      return structuredClone(sequenced);
    });
  }

  async enqueueSequencedEvent(event,options) {
    return (await this.enqueueSequencedEvents([event],options))[0];
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

  // Internal opt-in protocol adapter. Shares the exact event queue transaction
  // rather than maintaining a second, non-atomic queue beside normal events.
  observerTransaction(operation) { return this.#mutate(operation); }
  async observerState() { await this.lock.catch(()=>{}); return structuredClone(this.state); }
  observerRead(operation) { const run=this.lock.catch(()=>{}).then(()=>operation(structuredClone(this.state)));this.lock=run;return run; }

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
      if (state.processed_commands.length > this.processedCommandLimit) {
        state.processed_commands.splice(0, state.processed_commands.length - this.processedCommandLimit);
      }
    });
  }
}
