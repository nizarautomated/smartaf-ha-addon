ARG BUILD_FROM
FROM ${BUILD_FROM}

COPY requirements.txt /opt/smartaf/requirements.txt
RUN python3 -m pip install --no-cache-dir -r /opt/smartaf/requirements.txt

COPY run.sh /run.sh
COPY smartaf_deploy_agent.py /opt/smartaf/smartaf_deploy_agent.py
RUN chmod a+x /run.sh

CMD ["/run.sh"]
