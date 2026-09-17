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

# --- ide: install the vendored browser IDE on its required Node version ------
# code-server 4.104.x requires Node 22 (its postinstall.sh hard-fails on other
# majors), while the app itself builds on Node 20. A dedicated stage keeps both
# requirements satisfied without hacks.
FROM node:22-bookworm-slim AS ide
WORKDIR /ide
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
# Browser IDE runtime (vendored coder/code-server, installed on Node 22 in the
# ide stage). It spawns `node <entry.js>` using the RUNTIME stage's Node 20,
# which code-server tolerates at run time — the hard Node 22 check only lives
# in its postinstall script. Verify the entry exists at build time so a
# failed install can't silently produce an IDE-less image.
COPY --from=ide /ide/.code-server-src/runtime ./.code-server-src/runtime
# Bundle the Node 22 binary code-server was built for (the runtime stage's
# Node 20 ABI is needed by the app's native modules; code-server gets its own).
COPY --from=ide /usr/local/bin/node ./.code-server-src/node22/bin/node
RUN test -f .code-server-src/runtime/node_modules/code-server/out/node/entry.js \
    && .code-server-src/node22/bin/node --version \
    && mkdir -p .code-server-src/data/extensions
EXPOSE 8787
# The SQLite stats DB lives at /app/data — mount a persistent volume there so it
# survives container churn. On Railway, attach a Railway Volume at /app/data
# (the platform rejects a Dockerfile `VOLUME`); for plain Docker, bind-mount it:
# `docker run -v "$PWD/data:/app/data" …`.
CMD ["npm", "start"]
