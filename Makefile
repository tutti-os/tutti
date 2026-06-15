.PHONY: dev-cli dev-gui dev-web

export TUTTI_APP_UPDATE_CURRENT_VERSION
export TUTTI_APP_UPDATE_DEV
export TUTTI_APP_UPDATE_LATEST_VERSION
export TUTTI_APP_UPDATE_MOCK

dev-cli:
	@pnpm dev:cli

dev-gui:
	@bash ./tools/scripts/dev-gui.sh

dev-web:
	@pnpm dev:web
