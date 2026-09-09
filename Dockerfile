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
EXPOSE 8787
# The SQLite stats DB lives at /app/data — mount a persistent volume there so it
# survives container churn. On Railway, attach a Railway Volume at /app/data
# (the platform rejects a Dockerfile `VOLUME`); for plain Docker, bind-mount it:
# `docker run -v "$PWD/data:/app/data" …`.
CMD ["npm", "start"]
