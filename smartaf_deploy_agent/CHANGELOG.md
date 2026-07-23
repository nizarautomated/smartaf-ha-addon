# Changelog

## 0.3.2

- Validate the internal Home Assistant WebSocket proxy at startup.
- Authenticate with the existing Supervisor token, run one read-only `get_config` command, and close immediately.
- Log only connection metadata and the Home Assistant version; do not log entity data or tokens.

## 0.3.1

- Test read-only Home Assistant Core REST access at startup and log only the Core version.

## 0.3.0

- Enable authenticated read-only diagnostics through the Home Assistant Core API.
- Reuse the app's Supervisor token; no separate long-lived access token is required.

## 0.2.0

- Add validated Node-RED deployment with backup, restart verification, status reporting, and rollback.

## 0.1.0

- Initial SmartAF Node-RED Deploy Agent release.
