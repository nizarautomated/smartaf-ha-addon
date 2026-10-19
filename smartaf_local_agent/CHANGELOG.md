# Changelog

## 0.1.2

- Validate optional server command guards immediately before calling Home Assistant, including the current sensor state and its last change time, so renewed motion and off-on-off cycles reject an obsolete timer command.
- Reject guarded commands when the required state is missing, unknown or unavailable, when the state read fails or times out, or when the Home Assistant connection changes.
- Enforce command start times and recheck expiry after the state read; advertise `command_guards_v1` so the server can require compatible clients before delivering guarded commands.
- Preserve the 0.1.1 batch buffer, reconnect backpressure, existing configuration schema and transport-only responsibility. No new configuration fields or Home Assistant permissions are required.

## 0.1.1

- Drain durable event backlogs in bounded batches instead of rewriting the full queue after every acknowledgement.
- Pause Home Assistant subscriptions after a full-buffer signal until half of the durable queue has drained, preventing live events from immediately refilling the backlog.
- Keep event ordering, restart replay, sequence protection, the existing configuration schema and the transport-only responsibility unchanged.

## 0.1.0

- Introduce the SmartAF Local Agent as a transport-only Home Assistant app.
- Forward minimal state changes and sanitized service observations over HTTPS.
- Execute only tenant-bound, allowlisted, non-expired server commands.
- Persist event sequence, buffered events and command outcomes across restarts.
- Restore the server state cache with non-triggering snapshots after reconnects.
- Keep all triggers, conditions, timers and automation decisions off the Home Assistant host.
