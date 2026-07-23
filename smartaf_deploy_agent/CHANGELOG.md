# Changelog

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
