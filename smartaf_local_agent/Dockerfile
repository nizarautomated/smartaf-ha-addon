ARG BUILD_ARCH
FROM ghcr.io/home-assistant/${BUILD_ARCH}-base:3.22

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

ENV SMARTAF_AGENT_VERSION="${BUILD_VERSION}"

RUN apk add --no-cache nodejs

COPY package.json /opt/smartaf/package.json
COPY src /opt/smartaf/src
COPY run.sh /run.sh
RUN chmod 0555 /run.sh \
    && chmod -R a=rX /opt/smartaf

WORKDIR /opt/smartaf
CMD ["/run.sh"]
