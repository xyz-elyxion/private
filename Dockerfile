# Elyxion runtime image
# ---------------------------------------------------------------
# Installs the Elyxion standalone JS runtime using the official
# one-line installer:
#
#   curl -fsSL https://raw.githubusercontent.com/xyz-elyxion/elyxion-cli/main/scripts/install.sh | bash
#
# Ubuntu 24.04 (glibc 2.39, GCC 13) is required: the Elyxion v1.0.0
# binary needs GLIBC_2.38 / GLIBCXX_3.4.32, which Debian bookworm
# (glibc 2.36) does not provide.
#
# Build:
#   docker build -t elyxion .
#
# Run:
#   docker run --rm elyxion --version
#   docker run -it --rm elyxion --repl
# ---------------------------------------------------------------

FROM ubuntu:24.04

# The installer needs curl (bash, tar, coreutils, findutils are already
# present in the base image).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin a release by passing --build-arg ELYXION_VERSION=v1.0.0
ARG ELYXION_VERSION=latest
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

# `docker run --rm elyxion` prints the installed version and exits.
ENTRYPOINT ["elyxion"]
CMD ["--version"]
