ARG BUILD_FROM
FROM ${BUILD_FROM}

COPY run.sh /run.sh
COPY smartaf_deploy_agent.py /opt/smartaf/smartaf_deploy_agent.py
RUN chmod a+x /run.sh

CMD ["/run.sh"]
