# Analytics Reporter for Go

`reporter-go` is the product-neutral daemon analytics transport shared by Tutti
applications. It owns the DataFinder SDK adapter, stable device/session
identity, common parameter precedence, debug reporting, and disabled fallback.

Product repositories own event names, schemas, HTTP contracts, and typed event
helpers. Renderer code must report through its daemon rather than importing this
Go module directly.
