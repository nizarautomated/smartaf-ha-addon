#!/usr/bin/with-contenv bashio
set -euo pipefail

python3 /opt/smartaf/smartaf_log_collector.py &
collector_pid=$!
python3 /opt/smartaf/smartaf_command_runner.py &
command_runner_pid=$!
trap 'kill "$collector_pid" "$command_runner_pid" 2>/dev/null || true' EXIT INT TERM

python3 /opt/smartaf/smartaf_deploy_agent.py 2>&1 | tee -a /data/smartaf-agent.log
