# Market Go Client

`market-go` is the market-neutral generated client boundary for TSH Market.
Connector consumers pass `itemType=connector`; future Skill consumers pass
`itemType=skill`. The package does not own either product domain.

The generated protobuf and HTTP files are pinned to the exact `tsh-server`
commit and SHA-256 values in `source.lock.json`. Update them from a matching
local checkout with:

```sh
pnpm generate:market-go-client -- --source-root /path/to/tsh-server
```

The update command verifies that the checkout HEAD exactly matches the pinned
commit before it reads any generated files, then verifies each file digest. It
requires an authorized local service checkout. CI and local checks use the
vendored files and do not require network access:

```sh
pnpm check:api-generated
go test ./...
```

The client preserves the host-owned HTTP transport, timeout, gateway base
path, redirect policy, and request authorization callback. Redirects must stay
on the configured origin, so account credentials are never reattached after a
cross-origin or HTTPS-downgrade redirect. Successful response bodies are bounded
to 8 MiB and decoded with additive protobuf JSON fields ignored.
