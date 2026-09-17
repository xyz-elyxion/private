# Elyxion — multi-stage image.
#
# Build stage: install everything (incl. dev deps), compile native modules, and
# produce the client bundle in dist/. Runtime stage: a lean image with only
# production deps (tsx is a runtime dependency), the built client, the server,
# and the THREE-free shared game modules.

# --- build: compile the client bundle ---------------------------------------
FROM node:20.19-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 falls back to node-gyp when a matching prebuild is unavailable.
# Keep the compiler and Python only in this build stage; the runtime image stays
# free of native build tooling.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# Install deps first so this layer caches across source-only changes.
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# Remove dev dependencies after the client build. The resulting node_modules
# contains the native better-sqlite3 binary compiled for this Node/Linux image.
RUN npm prune --omit=dev
# Install the vendored browser IDE (coder/code-server) into its runtime dir.
# Same install as documented in .code-server-src/README.md — done at image build
# time so the committed repo doesn't have to carry the ~400 MB node_modules.
RUN mkdir -p .code-server-src/runtime \
    && cd .code-server-src/runtime \
    && npm init -y >/dev/null \
    && npm install code-server@4.104.2 --no-audit --no-fund --unsafe-perm

# --- runtime: serve dist/ + the game/stats server ---------------------------
FROM node:20.19-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787
# Reuse the production-pruned dependencies from the build stage instead of
# running npm ci again in the slim runtime image (which would need Python and a
# C/C++ toolchain to rebuild better-sqlite3).
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
# Built client, the server, and the shared game modules the server imports at
# runtime (src/game/{constants,arena-data,types}.ts). tsconfig* lets tsx resolve
# the project's module settings.
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/game ./src/game
COPY tsconfig*.json ./
# Browser IDE runtime (vendored coder/code-server, installed in the build stage).
COPY --from=build /app/.code-server-src/runtime ./.code-server-src/runtime
# Writable dirs code-server needs at runtime.
RUN mkdir -p .code-server-src/data/extensions
EXPOSE 8787
# The SQLite stats DB lives at /app/data — mount a persistent volume there so it
# survives container churn. On Railway, attach a Railway Volume at /app/data
# (the platform rejects a Dockerfile `VOLUME`); for plain Docker, bind-mount it:
# `docker run -v "$PWD/data:/app/data" …`.
CMD ["npm", "start"]
