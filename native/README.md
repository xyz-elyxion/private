# Elyxion native runtime substrate

Goal: the Elyxion CLI runs on **its own** execution layer — a vendored V8
engine plus Elyxion's own event loop — instead of the preinstalled Node.js
runtime. Everything in `native/` is Elyxion-owned code.

```
native/
  elyxion-loop.h/.cc   Elyxion's event loop: epoll-based, timer min-heap,
                       immediate queue. No libuv, no Node.
  elyxion-shell.cc     Elyxion's own V8 embedder ("our node"): isolate +
                       context, console/timers/fs/process host bindings,
                       driven by elyxion::Loop.
  setup.sh             One-shot: vendor V8, optionally build + link the shell.
  smoke.sh             Compiles + tests the loop; links & runs the shell once
                       the V8 monolith exists.
.v8-src/               Vendored V8 (shallow clone of tag 13.6.233, .git
                       stripped). Git-ignored — restored via native/setup.sh.
```

## Verify
```sh
sh native/setup.sh --build   # needs depot_tools (gn + ninja) + ~20 GB disk
sh native/smoke.sh           # after a monolith build, runs JS on our V8 + loop
```

Without depot_tools, `smoke.sh` still fully validates the event loop, and
`elyxion-shell.cc` is checked against the vendored V8 headers
(`g++ -std=c++20 -fsyntax-only -I.v8-src/v8/include native/elyxion-shell.cc`).

Full engine build instructions: `.v8-src/BUILDING.md`.
