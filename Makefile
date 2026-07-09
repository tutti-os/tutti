.PHONY: dev-cli dev-gui dev-web

NODE_PATH_PREFIX := $(shell node_major="$$(tr -d '[:space:]' < .node-version)"; node_dir="$$(find "$$HOME/.nvm/versions/node" -maxdepth 1 -type d -name "v$${node_major}.*" 2>/dev/null | awk -F/ '{ path = $$0; version = $$NF; sub(/^v/, "", version); split(version, parts, "."); printf "%d %d %d %s\n", parts[1], parts[2], parts[3], path }' | sort -n -k1,1 -k2,2 -k3,3 | tail -n 1 | cut -d ' ' -f 4-)"; if [ -x "$$node_dir/bin/node" ]; then printf '%s:' "$$node_dir/bin"; fi)
PNPM ?= PATH="$(NODE_PATH_PREFIX)$(PATH)" corepack pnpm@10.11.0

export TUTTI_APP_UPDATE_CURRENT_VERSION
export TUTTI_APP_UPDATE_DEV
export TUTTI_APP_UPDATE_LATEST_VERSION
export TUTTI_APP_UPDATE_MOCK

dev-cli:
	@$(PNPM) dev:cli

dev-gui:
	@bash ./tools/scripts/dev-gui.sh

dev-web:
	@$(PNPM) dev:web
