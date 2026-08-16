#!/usr/bin/with-contenv bashio
set -euo pipefail

export SMARTAF_HOME_ID="$(bashio::config 'home_id')"
export SMARTAF_AGENT_ID="$(bashio::config 'agent_id')"
export SMARTAF_CONTROL_PLANE_URL="$(bashio::config 'control_plane_url')"
export SMARTAF_AGENT_TOKEN="$(bashio::config 'agent_token')"
export SMARTAF_ALLOWED_SERVICES="$(bashio::config 'allowed_services')"
export SMARTAF_POLL_INTERVAL_MS="$(bashio::config 'poll_interval_ms')"
export SMARTAF_HEARTBEAT_INTERVAL_MS="$(bashio::config 'heartbeat_interval_ms')"
export SMARTAF_EVENT_QUEUE_LIMIT="$(bashio::config 'event_queue_limit')"
export SMARTAF_DATA_DIR=/data
export SMARTAF_AGENT_VERSION="${SMARTAF_AGENT_VERSION:-0.0.0}"

if [[ ${#SMARTAF_AGENT_TOKEN} -lt 32 ]]; then
  bashio::exit.nok "Vul eerst de unieke SmartAF agent_token van minimaal 32 tekens in."
fi

bashio::log.info "SmartAF Local Agent start voor ${SMARTAF_HOME_ID}; automationbeslissingen blijven op de server."
exec node /opt/smartaf/src/main.mjs
