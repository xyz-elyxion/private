# Elyxion runtime + site/registry server image
# ---------------------------------------------------------------
# Installs the Elyxion standalone JS runtime using the official
# one-line installer:
#
#   curl -fsSL https://raw.githubusercontent.com/xyz-elyxion/elyxion-cli/main/scripts/install.sh | bash
#
# then runs the site + package registry server from this repo
# (server.js) on the Elyxion runtime — no Node.js involved.
#
# Ubuntu 24.04 (glibc 2.39, GCC 13) is required: the Elyxion binary
# needs GLIBC_2.38 / GLIBCXX_3.4.32, which Debian bookworm (glibc 2.36)
# does not provide.
#
# Build:
#   docker build -t elyxion .
#
# Run:
#   docker run -d -p 3000:3000 -v elyxion-data:/app/data elyxion
#   curl http://localhost:3000/health
# ---------------------------------------------------------------

FROM ubuntu:24.04

# The installer needs curl (bash, tar, coreutils, findutils are already
# present in the base image).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin a known-good release (the installer defaults to v1.1.0; pass
# --build-arg ELYXION_VERSION=... to override). Do NOT use "latest" —
# release assets have shipped stale before.
ARG ELYXION_VERSION=v1.1.0
ENV ELYXION_VERSION=${ELYXION_VERSION}

# Install to /opt/elyxion (instead of the default $HOME/.elyxion) so the
# runtime works regardless of the user/HOME the container runs with, and
# put the `elyxion`/`elyx` wrapper scripts in /usr/local/bin (already on
# PATH). Without this, the installer defaults to ~/.local/bin, which is
# not on the container PATH.
ENV ELYXION_INSTALL_DIR=/opt/elyxion
ENV ELYXION_BIN_DIR=/usr/local/bin
RUN curl -fsSL https://raw.githubusercontent.com/xyz-elyxion/elyxion-cli/main/scripts/install.sh | bash \
    && rm -f /opt/elyxion/install.log

ENV ELYXION_HOME=/opt/elyxion

# ---- Site + registry server ------------------------------------
WORKDIR /app
COPY build.js server.js serve.js inline-server.js ./
COPY public/ public/

# Generate the static site into dist/ at build time (the server also
# falls back to this if dist/ is missing at startup).
RUN elyxion /app/build.js

EXPOSE 3000

# Registry data (users, tokens, packages) lives in /app/data — mount a
# volume here to keep it across container runs.
VOLUME ["/app/data"]

# `docker run elyxion` starts the site + registry server.
# Override the args for other uses, e.g. `docker run --rm elyxion --repl`.
ENTRYPOINT ["elyxion"]
CMD ["/app/server.js"]
