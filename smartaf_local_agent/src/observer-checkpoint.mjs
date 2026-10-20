// Candidate protocol only. Call while holding the same durable queue lock that
// enqueues events and commits observer receipts. Ordinary HTTP ACKs do not count.
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,96}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => new Date(value).toISOString();
export function observerQueueCheckpoint({ homeId, agentId, epoch, producedSequence, acknowledgedSequence,
  lossCounter, events, connected, now = Date.now() } = {}) {
  if (!/^home_[a-z0-9][a-z0-9_]{2,47}$/.test(homeId || '') || !id(agentId) || !id(epoch) ||
      ![producedSequence, acknowledgedSequence, lossCounter].every(count) || producedSequence < acknowledgedSequence ||
      !Array.isArray(events) || events.length > 5000 || events.length !== producedSequence - acknowledgedSequence ||
      typeof connected !== 'boolean' || !Number.isSafeInteger(now)) throw Error('invalid_observer_queue_checkpoint');
  let oldest = null;
  for (const [index, event] of events.entries()) {
    const at = Date.parse(event.occurred_at);
    if (event.home_id !== homeId || event.agent_id !== agentId || event.observer_epoch !== epoch ||
        event.sequence !== acknowledgedSequence + index + 1 || typeof event.event_id !== 'string' ||
        !Number.isFinite(at) || at > now) throw Error('observer_queue_not_contiguous');
    oldest = oldest === null ? at : Math.min(oldest, at);
  }
  return Object.freeze({ schema_version: 1, home_id: homeId, agent_id: agentId, epoch,
    produced_sequence: producedSequence, acknowledged_sequence: acknowledgedSequence, pending_count: events.length,
    oldest_pending_at: oldest === null ? null : iso(oldest), loss_counter: lossCounter,
    connected, captured_at: iso(now) });
}
