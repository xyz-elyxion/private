# Elyxion IDE — vendored code-server

The browser code editor (`/ide`) is powered by [coder/code-server](https://github.com/coder/code-server),
vendored into this repository at `.code-server-src/code-server` (shallow clone,
`.git` stripped) so the project owns its copy of the source.

## Layout

```
.code-server-src/
  code-server/   vendored source (reference / future patches), .git stripped
  runtime/       the installed npm package with the runnable binary
                 (committed to git — restore-from-source one-liner below if
                 it's ever missing on a fresh clone)
  data/          user-data-dir + extensions (git-ignored, created at runtime)
```

## Restore the runtime

The runtime is git-ignored — it's installed at Docker build time (see the
build stage in `Dockerfile`) so the repo stays lean. For local dev or a bare
(non-Docker) deploy, restore it with:

```sh
cd .code-server-src/runtime && npm install code-server@4.104.2 --no-audit --no-fund --unsafe-perm
sh scripts/rebrand-ide.sh   # apply Elyxion Codespace branding
```

## Branding

The editor is rebranded as **Elyxion Codespace** — `product.json` app names
(window title, menus, about dialog), the PWA manifest, and the user-visible
strings inside the workbench web bundle. The Dockerfile runs
`scripts/rebrand-ide.sh` right after installing code-server, so image builds
are branded automatically.

## How it's wired

- `server/ide.ts` spawns code-server bound to `127.0.0.1:$IDE_PORT`
  (default 8890) with `--auth none` — access is gated at the Elyxion proxy by
  the session cookie instead, so only signed-in users reach it.
- All `/ide/*` HTTP requests and WebSocket upgrades (VS Code's remote agent,
  integrated terminal, extension host) are proxied to the loopback upstream
  from `server/index.ts`. The upstream is never directly reachable.
- **Always on** — no enable flag. Disable with `ELYXION_IDE_DISABLED=1`.
