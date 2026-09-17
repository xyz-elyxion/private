#!/bin/sh
# Smoke test for the native runtime substrate.
#   sh native/smoke.sh
#
# Compiles the event loop against a tiny driver (no V8 needed — that part
# works even without the full engine build), and — if a vendored V8 with a
# compiled monolith is present (.v8-src/v8/out.gn/*/obj/libv8_monolith.a) —
# compiles + runs the full shell against a hello-world script.

set -e
cd "$(dirname "$0")/.."

echo "== elyxion-loop: compile =="
g++ -std=c++20 -Wall -Wextra -O2 native/elyxion-loop.cc -c -o /tmp/elyxion-loop.o
echo "ok"

echo "== elyxion-loop: behavior =="
cat > /tmp/loop-smoke.cc <<'EOF'
#include "native/elyxion-loop.h"
#include <cstdio>
int main() {
  elyxion::Loop loop;
  int ticks = 0;
  loop.setInterval(5, [&] {
    printf("tick %d\n", ++ticks);
    if (ticks >= 3) loop.stop();
  });
  loop.run();
  printf("stopped after %d ticks\n", ticks);
  return 0;
}
EOF
g++ -std=c++20 -Wall -O2 /tmp/loop-smoke.cc native/elyxion-loop.cc -I. -o /tmp/loop-smoke
timeout 10 /tmp/loop-smoke
echo "ok"

MONOLITH=$(ls .v8-src/v8/out*/obj/libv8_monolith.a 2>/dev/null | head -1 || true)
if [ -z "$MONOLITH" ]; then
  echo "== elyxion-shell: SKIPPED (no compiled V8 monolith yet) =="
  echo "   Vendored V8 is present in .v8-src/v8 but not built."
  echo "   Build it with depot_tools (gn+ninja) per .v8-src/README.md, then rerun."
  exit 0
fi

echo "== elyxion-shell: compile =="
V8OUT=$(dirname "$MONOLITH")/../..
g++ -std=c++20 -O2 -I.v8-src/v8/include -I. \
  native/elyxion-shell.cc native/elyxion-loop.cc \
  "$MONOLITH" -pthread -ldl -o /tmp/elyxion-shell
echo "ok"

echo "== elyxion-shell: run =="
cat > /tmp/hello.mjs <<'EOF'
console.log("elyxion-shell says hello from its own V8 + own event loop");
setTimeout(() => {
  console.log("timer fired on elyxion's loop");
  __elyxionExit(0);
}, 20);
EOF
/tmp/elyxion-shell /tmp/hello.mjs
echo "ok"
