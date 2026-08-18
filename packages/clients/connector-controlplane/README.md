# Connector Control Plane Go Client

`connector-controlplane` owns the shared account-scoped Connector
authorization wire client used by Tutti and TSH.

It owns:

- authorization session start, replacement, session cancellation, observation,
  secret completion, and disconnect;
- authoritative account authorization snapshots;
- the `connector.authorization.changed` realtime event protocol;
- bounded HTTP responses, safe redirect validation, and clearing mutable secret
  buffers after submission.

It does not own account cookies, bearer tokens, user or device headers,
deployment endpoint selection, credential persistence, runtime reconciliation,
or product retry policy. Hosts inject those concerns through request-authorizer
callbacks and explicit base URL/API prefix configuration. Provider credentials
must never be logged or transferred to a Connector VM.

## Usage

```go
client, err := connectorcontrolplane.NewAuthorizationClient(
    connectorcontrolplane.AuthorizationClientConfig{
        BaseURL:    "https://api.example.com",
        APIPrefix: "/api/desktop/v1",
        HTTPClient: productHTTPClient,
        AuthorizeAccountRequest: func(request *http.Request, accountID string) error {
            addCurrentAccountSession(request, accountID)
            return nil
        },
    },
)
```

The client implements the Connector Host `AuthorizationProvider`,
`AuthorizationAttemptCanceler`, `AuthorizationObserver`, and
`AuthorizationSnapshotSource` ports. Products compose it with
`host.NewImplementationAuthorizationRouter`: remote HTTP Connectors use this
client while managed stdio Connectors keep their implementation-owned
credential broker.

## Validation and releases

Run:

```sh
go test -race ./...
```

The module participates in Tutti's shared stable `packages/**` Go release
cohort. Cross-repository consumers must use a released module tag.
