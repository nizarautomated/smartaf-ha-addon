# Changelog

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
