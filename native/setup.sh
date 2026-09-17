#!/bin/sh
# One-shot helper: vendor V8 (own copy, .git stripped) and, when depot_tools
# is available, build the monolith and link the Elyxion shell.
#
#   sh native/setup.sh            # vendor + link if V8 already built
#   sh native/setup.sh --build    # also run the gn/ninja monolith build
set -e
cd "$(dirname "$0")/.."

if [ ! -d .v8-src/v8 ]; then
  echo "== vendoring V8 (shallow clone, .git stripped) =="
  mkdir -p .v8-src
  git clone --depth 1 --branch 13.6.233 https://github.com/v8/v8.git .v8-src/v8
  rm -rf .v8-src/v8/.git
fi
echo "vendored V8 present: $(du -sh .v8-src/v8 | cut -f1)"

if [ "${1:-}" = "--build" ]; then
  if ! command -v gn >/dev/null || ! command -v ninja >/dev/null; then
    echo "gn/ninja not found — install depot_tools first (see .v8-src/BUILDING.md)" >&2
    exit 1
  fi
  (cd .v8-src/v8 && gn gen out/elyxion --args='
    is_component_build=false
    v8_monolithic=true
    v8_static_library=true
    v8_use_external_startup_data=false
    v8_enable_i18n_support=false
    v8_enable_webassembly=false
    v8_enable_debugging_features=false
    v8_enable_disassembler=false
    use_custom_libcxx=false
    v8_enable_pointer_compression=false
    v8_enable_sandbox=false
    symbol_level=0
    is_debug=false
  ' && ninja -C out/elyxion v8_monolith)
fi

sh native/smoke.sh
