# Changelog

## 0.1.8

- Add optional private presence categories for explicitly selected person entities. Local mappings keep zone names, SSIDs and coordinates out of telemetry; the existing ordinary state filter remains unchanged and unlisted zones remain unknown.
- Bind category observations to the home, person, configuration epoch and original observation times. Restored or invalid observations cannot supply a trusted category. Household decisions remain on the central server.
- Keep saved options and policies without this opt-in compatible. No new Home Assistant or Supervisor permissions, support access, runtime commands, host ports or local automation timers are added. Enabling the optional policy requires a compatible central server and matching shadow profile first.

## 0.1.7

- Add an optional, disabled-by-default observer stream for schema-2 shadow profiles. Keep queued observations until the central observer has durably committed its own receipt; ordinary transport acknowledgements cannot discard them.
- Require a server-bound fresh snapshot after real continuity loss. Fence local observation and storage failures immediately, reject stale connection callbacks, bound snapshot capture and avoid repeated disconnect requests while offline.
- Add optional local display names to the support consent interface. Names stay local and cannot expand approved actions, entities, account identity or expiry; exact technical scope remains available.
- Keep household decisions central and physical command permissions unchanged. The new observer option is optional for existing saved configurations; no Supervisor access, host ports or additional Home Assistant permissions are added.

## 0.1.6

- Keep read-only support sessions open during ordinary automation telemetry backlogs and observer snapshot refreshes. Distinguish the server process from its observer resynchronization token; real connection loss, process replacement, expiry and local revocation still invalidate support.
- Add bounded support transition reason codes for troubleshooting without logging grant contents, Home Assistant users, credentials or household values.
- Add optional transport of an exact solar-day fact from two locally selected Home Assistant Sun timestamp history sources. Queries and results are bounded and tied to the home, timezone, source binding, configuration epoch and current connection; no location or raw history is exported.
- Keep solar history disabled unless explicitly configured in the existing optional local policy. Existing saved options remain compatible, no Home Assistant or Supervisor permissions or host ports are added, and household decisions stay on the central server.

## 0.1.5

- Add an optional read-only support consent interface through Home Assistant Ingress. Only explicitly allowed local Home Assistant users can approve an exact pending incident request; grants expire within 30 minutes and can be revoked locally.
- Add separately scoped support polling, request and report checks, bounded structured diagnostics and session invalidation on disconnect, restart, policy changes or revoked access. Support remains disabled without explicit optional configuration and local policy; no runtime service permissions are added.
- Keep consent secrets local and in memory. Support reports exclude raw logs, attributes, personal location data, Home Assistant user identities and credentials.
- Preserve command outcome evidence before acknowledgement retries, so an acknowledgement failure does not execute a successful Home Assistant call again. Optional own-command context evidence remains bounded and does not prove device behavior.
- Keep existing saved configurations compatible. No new Supervisor permissions, host ports or household automation logic are introduced.

## 0.1.4

- Allow an optional list of permitted state values for selected telemetry entities. Values outside that list become `unknown`, including buffered events and snapshots; personal zone names are not inferred to mean away.
- Keep existing policies and saved configurations compatible. No new permissions, automation logic or remote support grants are enabled.

## 0.1.3

- Forward only typed restoration and last-change metadata, plus next sunrise/sunset timestamps for the sun entity, so the central household observer can distinguish restored sensor values from fresh observations.
- Add optional local access policy configuration. Explicit policies constrain runtime commands to reviewed direct device platforms, exact entities, services and bounded parameters; a disabled policy stops commands and telemetry. Existing saved configurations without the optional field keep their transport behavior.
- Recheck policy, actual entity registry, connection and expiry before execution; re-filter buffered events against the current local policy before transmission.
- Add locally authorized, time-bounded read-only incident primitives with separate operator/home scopes, revocation and redaction. These primitives do not enable remote support automatically; an incident consent/transport interface is still required.
- Preserve batch buffering, reconnect backpressure and the transport-only role. No additional Home Assistant or Supervisor permissions are requested.

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
