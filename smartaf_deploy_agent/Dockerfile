ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache python3 py3-pip

COPY requirements.txt /opt/smartaf/requirements.txt
RUN python3 -m pip install --no-cache-dir -r /opt/smartaf/requirements.txt

COPY run.sh /run.sh
COPY smartaf_deploy_agent.py /opt/smartaf/smartaf_deploy_agent.py
COPY smartaf_log_collector.py /opt/smartaf/smartaf_log_collector.py
RUN chmod a+x /run.sh

CMD ["/run.sh"]
