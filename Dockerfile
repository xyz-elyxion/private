# Elyxion runtime + site/registry server image
# ---------------------------------------------------------------
# Installs the Elyxion standalone JS runtime using the official
# one-line installer.
#
# Build from the private directory:
#   docker build -t elyxion .
#
# Run:
#   docker run -d -p 3000:3000 -v elyxion-data:/app/data elyxion
#   curl http://localhost:3000/health
# ---------------------------------------------------------------

FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG ELYXION_VERSION=v1.1.0
ENV ELYXION_VERSION=${ELYXION_VERSION}
ENV ELYXION_INSTALL_DIR=/opt/elyxion
ENV ELYXION_BIN_DIR=/usr/local/bin
RUN curl -fsSL https://raw.githubusercontent.com/xyz-elyxion/elyxion-cli/main/scripts/install.sh | bash \
    && rm -f /opt/elyxion/install.log

ENV ELYXION_HOME=/opt/elyxion

WORKDIR /app
COPY build.js server.js serve.js inline-server.js start.js bot.js ./
COPY public/ public/
COPY theme/ theme/
COPY commands/ commands/
COPY discord-framework/ discord-framework/

RUN elyxion /app/build.js

# Fail during the image build with a useful message if the combined entry
# point or vendored framework was not included in the Render context.
RUN test -f /app/start.js && test -f /app/discord-framework/index.js && test -d /app/discord-framework/lib

EXPOSE 3000
VOLUME ["/app/data"]

ENTRYPOINT ["elyxion"]
CMD ["/app/start.js"]
