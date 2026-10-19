function reject(code) {
  throw Object.assign(new Error("Opdracht voldoet niet aan lokale uitvoeringsvoorwaarden"), { code, safetyRejection: true });
}

// This is a dispatch precondition, not local automation logic. The server owns
// the rule and timer; the agent only refuses an obsolete or unsafe instruction.
export async function assertCommandReady(command, { client, isCurrentClient = () => true, clock = Date.now, readTimeoutMs = 2_000 } = {}) {
  function checkConnectionAndDeadline() {
    if (!client?.connected) reject("ha_disconnected");
    if (!isCurrentClient(client)) reject("ha_connection_changed");
    const now = clock();
    if (Date.parse(command.not_before) > now) reject("command_not_before");
    if (Date.parse(command.expires_at) <= now) reject("command_expired");
  }

  checkConnectionAndDeadline();
  if (!command.guard) return;
  let timeout;
  let states;
  try {
    // get_states is the existing HA API used for the agent snapshot. Only the
    // selected state and last_changed are inspected here; nothing is logged,
    // stored or uploaded by this check.
    states = await Promise.race([
      client.getStates(),
      new Promise((_, rejectTimeout) => {
        timeout = setTimeout(() => rejectTimeout(new Error("guard read timeout")), readTimeoutMs);
      })
    ]);
  } catch {
    checkConnectionAndDeadline();
    reject("guard_state_unavailable");
  } finally {
    clearTimeout(timeout);
  }
  checkConnectionAndDeadline();
  if (!Array.isArray(states)) reject("guard_state_unavailable");
  const observed = states.find((state) => state.entity_id === command.guard.entity_id);
  if (!observed) reject("guard_state_missing");
  if (typeof observed.state !== "string" || ["unknown", "unavailable"].includes(observed.state)) reject("guard_state_unavailable");
  if (observed.state !== command.guard.state) reject("guard_condition_changed");
  const lastChanged = Date.parse(observed.last_changed);
  if (!Number.isFinite(lastChanged)) reject("guard_state_unavailable");
  // An off-on-off cycle must reset the server timer. Merely seeing "off" again
  // is not enough to authorise an instruction issued before the new cycle.
  if (lastChanged > Date.parse(command.guard.observed_at)) reject("guard_observation_superseded");
}
