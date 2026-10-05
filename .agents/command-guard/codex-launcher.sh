#!/bin/sh
# Toucan's CODEX_PATH outside Windows: codex-acp runs `<this file> app-server`. ELECTRON_RUN_AS_NODE
# makes Toucan's own binary run the launcher as Node; the launcher removes it again before it starts
# Codex (AGENTS.md, #226).
ELECTRON_RUN_AS_NODE=1 exec "$TOUCAN_CODEX_RUNTIME" "$(dirname "$0")/codex-launcher.mjs" "$@"
