# Changelog

## 0.6.4

- Add bounded read-only log sources for Home Assistant Core, Supervisor, host, DNS, audio, multicast, and every installed Home Assistant app.
- Add the fixed `all` source alias while keeping arbitrary filesystem paths and arbitrary app slugs forbidden.
- Cap every combined log report at 2,000 lines, cap individual requests at 500 lines per source, and retain credential redaction.
- Use the official Supervisor journal endpoints with timestamps and terminal colors removed.
- Do not add or change any user configuration fields, preserving upgrade compatibility.


## 0.6.3

- Fix the Alpine 3.22 PEP 668 build failure by explicitly allowing pip to install the pinned Python dependency inside the isolated add-on container.
- Keep the existing architecture-specific Home Assistant base images and runtime entrypoint unchanged.
- Do not add or change any user configuration fields.

## 0.6.2

- Restore build compatibility with Home Assistant Supervisor 2026.04 and newer by explicitly defining architecture-specific base images in `build.yaml`.
- Keep the app Dockerfile's `BUILD_FROM` contract while no longer depending on Supervisor's removed implicit fallback.
- Do not add or change any user configuration fields.

## 0.6.1

- Remove the log diagnostic settings from the Supervisor schema entirely because the collector already has safe internal defaults.
- Keep existing stored app configurations unchanged so Supervisor can offer the update without requiring new fields.

## 0.6.0

- Add bounded, read-only log diagnostics requested through `diagnostics/log_request.json`.
- Support explicit allowlisted sources for Home Assistant Core, Node-RED, and the SmartAF Deploy Agent.
- Limit reports to the requested tail size and redact bearer tokens, authorization headers, GitHub tokens, webhook secrets, passwords, and URL credentials before publication.
- Publish sanitized reports under `diagnostics/log_reports/`; never expose arbitrary filesystem paths or add-on slugs from a request.
- Keep every new option optional with internal defaults so existing installations remain upgrade-compatible.

## 0.5.3

- Fix the optional `current_flows_path` schema syntax so Supervisor no longer interprets `current_flows_path?` as a literal required option name.
- Remove the option-level default so upgrades without this stored field remain valid; the agent keeps using its built-in `current/flows.json` fallback.

## 0.5.2

- Keep upgrades from older installations compatible by making `current_flows_path` optional in the app configuration schema.
- Preserve the built-in `current/flows.json` default when the option is absent.
- Publish release notes before raising the app version so Supervisor can index the changelog before offering the update.

## 0.5.1

- Compare the validated live Node-RED graph with `current/flows.json` on every poll.
- Write the live graph back only when its canonical hash differs.
- Retry repository synchronization after transient GitHub failures without blocking Node-RED deployments.
- Document the existing Home Assistant custom integration mount accurately.

## 0.5.0

- Sync an explicit allowlist of SmartAF custom integration files into Home Assistant config.
- Write each integration file atomically and never modify `configuration.yaml` or `.storage`.
- Keep future custom integration code updates separate from SmartAF app releases.
- Require a Home Assistant Core restart after a changed integration bundle is synced.

## 0.4.1

- Ignore attribute-only Home Assistant updates where the old and new entity state are equal.
- Keep diagnostic event reports limited to actual state transitions.

## 0.4.0

- Add bounded read-only entity diagnostics requested through `diagnostics/request.json`.
- Allow 1–10 explicit entity IDs and a 10–120 second measurement window.
- Capture only initial states and filtered state transitions for those entities.
- Publish sanitized reports under `diagnostics/reports/` without attributes, context IDs, tokens, service calls, or unrelated entities.
- Process each `diagnostic_id` only once.
- Verify that Supervisor actually indexed each published app version before marking the refresh complete.
- Retry store reloads and use the official repository repair endpoint once when metadata remains stale.
- Refresh Home Assistant update metadata only after the store reports the expected version; updates remain manual.

## 0.3.2

- Validate the internal Home Assistant WebSocket proxy at startup.
- Authenticate with the existing Supervisor token, run one read-only `get_config` command, and close immediately.
- Log only connection metadata and the Home Assistant version; do not log entity data or tokens.
- Detect a newer published SmartAF app version and refresh Supervisor store metadata once per version.

## 0.3.1

- Test read-only Home Assistant Core REST access at startup and log only the Core version.

## 0.3.0

- Enable authenticated read-only diagnostics through the Home Assistant Core API.
- Reuse the app's Supervisor token; no separate long-lived access token is required.

## 0.2.0

- Add validated Node-RED deployment with backup, restart verification, status reporting, and rollback.

## 0.1.0

- Initial SmartAF Node-RED Deploy Agent release.
