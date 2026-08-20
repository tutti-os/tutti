# Device Authority Go Client

`device-authority-go` is the narrow, shared Device Authority owner-lifecycle
client boundary for Tutti and TSH. It prevents the security-sensitive
enrollment and owner-token signing protocol from drifting between products.

This initial extraction is a staged cross-repository bootstrap from TSH's
production implementation. The stable module is published first; TSH then
switches to the released module without behavior changes; Tutti consumes the
same boundary next. Cross-repository consumers must not bridge that ordering
with a workspace replacement or pseudo-version. Update this section when those
consumer cutovers land so it continues to describe current integration state.

The module owns:

- Device Authority ensure, gateway identity enrollment, owner-tunnel token,
  and lease-renewal HTTP wire contracts;
- the canonical `tsh.gateway.owner-session.v1` Ed25519 signing payload;
- response-to-request credential binding checks;
- `ErrResponseBinding` for adapters to fail closed when a lease response is
  bound to a different authority;
- bounded response and HTTP error metadata handling;
- a reusable process-local Ed25519 identity source compatible with TSH's
  current behavior.

The module does not own account cookies, bearer tokens, user/device/lane
headers, endpoint selection, identity persistence policy, Relay demand,
reconnection, lease scheduling, logging, or product retry decisions. Consumers
inject those concerns through `Config` and `IdentitySource`. Relay byte-stream
mechanics remain in `packages/device-link/relaytransport`.

## Usage

```go
identities := deviceauthority.NewMemoryIdentitySource()
client, err := deviceauthority.NewClient(deviceauthority.Config{
    BaseURL:   controlPlaneBaseURL,
    APIPrefix: controlPlaneAPIPrefix,
    HTTPClient: productHTTPClient,
    Identities: identities,
    PrepareRequest: func(req *http.Request, metadata deviceauthority.RequestMetadata) error {
        addCurrentProductHeaders(req, metadata.OwnerUserID)
        return nil
    },
})
```

`APIPrefix` is required because choosing `/v1` versus a product gateway path is
deployment policy. The shared client never guesses from the host name.

`MemoryIdentitySource` retains one key per runtime only for the current process.
It is intended for consumers preserving an existing process-local identity
contract. A product that requires restart-stable identity must implement
`IdentitySource` with its durable credential store and must return the same
signing identity for enrollment retries and token issuance.

The owner sequence is:

```text
product demand
  -> EnsureDeviceAuthority
  -> RegisterDeviceGatewayIdentity
  -> IssueDeviceGatewayOwnerTunnelToken
  -> product starts relaytransport.OwnerHost
  -> RenewDeviceAuthorityLease on the product schedule while its server
     `ExpiresAt` remains fresh
  -> product releases Relay demand
```

Do not log private keys, tokens, enrollment proofs, signatures, raw response
bodies, or request headers. `HTTPError.Body` exists for adapter-owned protocol
handling and is bounded to 4096 bytes; ordinary logs should use status and
categorical reasons instead. The ordinary `error` string contains only the HTTP
status and never includes `Body`.

## Validation and releases

Run:

```sh
go test -race ./...
```

The module participates in Tutti's shared stable `packages/**` Go release
cohort. Cross-repository consumers must use the released module tag and must not
add a workspace replacement or pseudo-version.
