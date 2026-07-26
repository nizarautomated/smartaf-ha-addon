#!/usr/bin/with-contenv bashio
set -euo pipefail

python3 /opt/smartaf/smartaf_log_collector.py &
collector_pid=$!
python3 /opt/smartaf/smartaf_command_runner.py &
command_runner_pid=$!
python3 /opt/smartaf/smartaf_approval_runner.py &
approval_runner_pid=$!
python3 /opt/smartaf/smartaf_maintenance.py &
maintenance_pid=$!
trap 'kill "$collector_pid" "$command_runner_pid" "$approval_runner_pid" "$maintenance_pid" 2>/dev/null || true' EXIT INT TERM

python3 /opt/smartaf/smartaf_deploy_agent.py 2>&1 | tee -a /data/smartaf-agent.log

