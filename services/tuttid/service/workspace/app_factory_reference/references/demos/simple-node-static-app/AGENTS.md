# Simple Node Static Demo

Package layout:

- `tutti.app.json`: app manifest.
- `bootstrap.sh`: launches `server.js`.
- `server.js`: serves `/healthz`, static HTML, and JSON endpoints.
- `static/`: browser assets.

Runtime:

- Tutti starts `bootstrap.sh` with no arguments from `TUTTI_APP_RUNTIME_DIR`.
- Launch `server.js` with `TUTTI_APP_NODE`.
- Bind `TUTTI_APP_HOST` and `TUTTI_APP_PORT`.
- Read package assets from `TUTTI_APP_PACKAGE_DIR`.
- Store durable JSON data in `TUTTI_APP_DATA_DIR`.
- Use `TUTTI_APP_RUNTIME_DIR` for scratch files and `TUTTI_APP_LOG_DIR` for logs.

Local run example:

```sh
APP_DIR="$PWD"
RUN_DIR="$(mktemp -d)"
NODE_BIN="${TUTTI_APP_NODE:?Set TUTTI_APP_NODE to the managed Node binary}"
TUTTI_APP_HOST=127.0.0.1 \
TUTTI_APP_PORT=8787 \
TUTTI_APP_BASE_URL=http://127.0.0.1:8787 \
TUTTI_APP_PACKAGE_DIR="$APP_DIR" \
TUTTI_APP_RUNTIME_DIR="$RUN_DIR/runtime" \
TUTTI_APP_DATA_DIR="$RUN_DIR/data" \
TUTTI_APP_LOG_DIR="$RUN_DIR/logs" \
TUTTI_APP_NODE="$NODE_BIN" \
./bootstrap.sh
```

Endpoints:

- `GET /healthz`: healthcheck.
- `GET /api/state`: reads durable JSON state from `TUTTI_APP_DATA_DIR`.

Modification guidance:

- Keep package files self-contained.
- Keep runtime writes out of the package directory.
- Read locale from the optional host app context or browser locale APIs.
- Use CSS `prefers-color-scheme` for theme rendering.
