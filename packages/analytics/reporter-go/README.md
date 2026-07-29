# Analytics Reporter for Go

`reporter-go` is the product-neutral daemon analytics transport shared by Tutti
applications. It owns the DataFinder SDK adapter, stable device/session
identity, common parameter precedence, debug reporting, and disabled fallback.

Product repositories own event names, schemas, HTTP contracts, and typed event
helpers. Renderer code must report through its daemon rather than importing this
Go module directly.

Production DataFinder reporting requires either `Config.StateDir` or an explicit
`Config.SDKLogDir` for bounded SDK log files. `SDKLogDir` is useful when a host
must preserve an existing log path; otherwise logs default to
`<StateDir>/analytics/sdk-logs`. Debug-only reporting may omit both when a stable
device ID is supplied.

The DataFinder SDK is process-global. A process may construct multiple
production reporters only when their App ID, key, endpoint, and SDK log
directory are identical; a conflicting second configuration returns an error.
