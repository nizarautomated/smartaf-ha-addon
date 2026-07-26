ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache python3 py3-pip

COPY requirements.txt /opt/smartaf/requirements.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages -r /opt/smartaf/requirements.txt

COPY run.sh /run.sh
COPY smartaf_deploy_agent.py /opt/smartaf/smartaf_deploy_agent.py
COPY smartaf_log_collector.py /opt/smartaf/smartaf_log_collector.py
COPY smartaf_command_runner.py /opt/smartaf/smartaf_command_runner.py
COPY smartaf_approval.py /opt/smartaf/smartaf_approval.py
COPY smartaf_approval_runner.py /opt/smartaf/smartaf_approval_runner.py
COPY smartaf_maintenance.py /opt/smartaf/smartaf_maintenance.py
RUN chmod a+x /run.sh

CMD ["/run.sh"]
