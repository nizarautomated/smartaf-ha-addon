import { createSolarHistoryRequest, normalizeSolarHistory } from './solar-history.mjs';
import { selectTelemetry, solarHistoryConfiguration } from './access-policy.mjs';
import { stateSnapshotFromHomeAssistant } from './protocol.mjs';

// A snapshot is the sole carrier. No independent historical state events are
// replayed and no decision about a household device is made here.
export async function captureStateSnapshot({ client, homeId, agentId, policy, connectionEpoch, isCurrent, clock = Date.now }) {
  const assertCurrent = () => {
    if (!client.connected || !isCurrent()) throw Object.assign(new Error('Snapshot connection changed'), { code: 'ha_disconnected' });
  };
  assertCurrent();
  const configuration = solarHistoryConfiguration(policy, homeId);
  let solar, solarReason = 'solar_history_disabled';
  if (configuration) {
    const args = { homeId, timezone: configuration.timezone, sourceEntities: configuration.source_entities,
      configurationEpoch: configuration.configuration_epoch, connectionEpoch, now: clock() };
    const request = createSolarHistoryRequest(args);
    try {
      const history = await client.getSolarHistory(args);
      assertCurrent();
      const normalized = normalizeSolarHistory({ request, history, ...args, now: clock() });
      solar = normalized.fact; solarReason = normalized.reason_code;
    } catch { solarReason = 'solar_history_read_failed'; }
  }
  assertCurrent();
  // Read current states after the bounded history request: waiting for history
  // must not relabel an older full snapshot as current.
  const states = await client.getStates({timeoutMs:5000});
  assertCurrent();
  if (!Array.isArray(states)) throw Object.assign(new Error('Invalid HA states'), { code: 'ha_invalid_states' });
  const capturedAt = new Date(clock()).toISOString();
  const raw = stateSnapshotFromHomeAssistant({ homeId, agentId, states, capturedAt });
  if (configuration) {
    raw.payload.solar_context = { schema_version: 1, home_id: homeId, timezone: configuration.timezone,
      source_entities: { ...configuration.source_entities }, configuration_epoch: configuration.configuration_epoch,
      connection_epoch: connectionEpoch, observed_at: capturedAt };
    if (solar) raw.payload.solar_day = solar;
  }
  const snapshot = selectTelemetry(raw, { policy, homeId });
  if (solar && !snapshot?.payload.solar_day) solarReason = 'solar_history_snapshot_stale';
  return { snapshot, solarReason };
}
