package host

import (
	"context"
	"testing"
)

func TestAccountRuntimeBindingResolverKeepsAuthorizedConnectorInactiveWithoutProjection(t *testing.T) {
	release := testReleaseWithImplementation("github", "1.0.0", ImplementationKindManagedStdio)
	release.Manifest.AuthorizationKind = "oauth2"
	resolver := AccountRuntimeBindingResolver{}
	binding, err := resolver.ResolveRuntimeBinding(context.Background(), RuntimeBindingRequest{
		Scope: OperationScope{AccountID: "account-1"}, Connector: Connector{Key: "github"}, Release: release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if binding.Enabled || binding.ConnectionID != AccountRuntimeConnectionID("account-1", "github") {
		t.Fatalf("binding = %#v", binding)
	}
}

func TestAccountRuntimeBindingResolverKeepsAuthorizedConnectorInactiveWhileSignedOut(t *testing.T) {
	release := testReleaseWithImplementation("github", "1.0.0", ImplementationKindManagedStdio)
	release.Manifest.AuthorizationKind = "oauth2"
	binding, err := (AccountRuntimeBindingResolver{}).ResolveRuntimeBinding(context.Background(), RuntimeBindingRequest{
		Connector: Connector{Key: "github"}, Release: release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if binding.Enabled || binding.ConnectionID != AccountRuntimeConnectionID("signed-out", "github") {
		t.Fatalf("binding = %#v", binding)
	}
}

func TestAccountRuntimeBindingResolverIssuesGrantOnlyForConnectedProjection(t *testing.T) {
	release := testReleaseWithImplementation("github", "1.0.0", ImplementationKindManagedStdio)
	release.Manifest.AuthorizationKind = "oauth2"
	release.Manifest.Implementation.ManagedStdio.CredentialBroker = nil
	projections := &authorizationProjectionStoreStub{projection: AuthorizationProjection{
		AccountID: "account-1", ConnectorKey: "github", ConnectionID: "server-connection", State: AuthorizationStateConnected,
	}}
	credentials := &credentialGrantIssuerStub{grant: []byte("grant")}
	resolver := AccountRuntimeBindingResolver{Projections: projections, Credentials: credentials}
	binding, err := resolver.ResolveRuntimeBinding(context.Background(), RuntimeBindingRequest{
		Scope: OperationScope{AccountID: "account-1"}, Connector: Connector{Key: "github"}, Release: release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !binding.Enabled || binding.ConnectionID != "server-connection" || string(binding.CredentialBrokerGrant) != "grant" || credentials.calls != 1 {
		t.Fatalf("binding = %#v, credential calls = %d", binding, credentials.calls)
	}
	projections.projection.State = AuthorizationStateExpired
	binding, err = resolver.ResolveRuntimeBinding(context.Background(), RuntimeBindingRequest{
		Scope: OperationScope{AccountID: "account-1"}, Connector: Connector{Key: "github"}, Release: release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if binding.Enabled || len(binding.CredentialBrokerGrant) != 0 || credentials.calls != 1 {
		t.Fatalf("expired binding = %#v, credential calls = %d", binding, credentials.calls)
	}
	projections.projection.State = AuthorizationStateConnected
	binding, err = resolver.ResolveRuntimeBinding(context.Background(), RuntimeBindingRequest{
		Scope: OperationScope{AccountID: "account-1"}, Purpose: RuntimeBindingPurposeDeactivate,
		Connector: Connector{Key: "github"}, Release: release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !binding.Enabled || len(binding.CredentialBrokerGrant) != 0 || credentials.calls != 1 {
		t.Fatalf("deactivation binding = %#v, credential calls = %d", binding, credentials.calls)
	}
}

func TestAccountRuntimeBindingResolverUsesConnectorOwnedCredentialBrokerWithoutServerGrant(t *testing.T) {
	release := testReleaseWithImplementation("lark-cli", "1.0.0", ImplementationKindManagedStdio)
	release.Manifest.AuthorizationKind = "oauth2"
	release.Manifest.Implementation.ManagedStdio.CredentialBroker = &ManagedCredentialBroker{
		Protocol: CredentialBrokerProtocolV1, Entrypoint: "credential-broker.mjs", TimeoutMS: 30_000,
	}
	projections := &authorizationProjectionStoreStub{projection: AuthorizationProjection{
		AccountID: "account-1", ConnectorKey: "lark-cli", State: AuthorizationStateConnected,
	}}
	binding, err := (AccountRuntimeBindingResolver{Projections: projections}).ResolveRuntimeBinding(context.Background(), RuntimeBindingRequest{
		Scope: OperationScope{AccountID: "account-1"}, Connector: Connector{Key: "lark-cli"}, Release: release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !binding.Enabled || binding.ConnectionID != AccountRuntimeConnectionID("account-1", "lark-cli") || len(binding.CredentialBrokerGrant) != 0 {
		t.Fatalf("binding = %#v", binding)
	}
}

func TestAccountRuntimeBindingResolverUsesServerConnectionForRemoteMCPWithoutGrant(t *testing.T) {
	release := testReleaseWithImplementation("tencent-docs", "1.0.0", ImplementationKindRemoteStreamableHTTP)
	release.Manifest.Implementation = Implementation{
		Kind: ImplementationKindRemoteStreamableHTTP,
		RemoteStreamableHTTP: &RemoteStreamableHTTPImplementation{
			ProtocolVersion:     "2026-07-28",
			BindingRef:          "tencent-docs.primary",
			ContractVersion:     1,
			BindingContractHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
	}
	release.Manifest.AuthorizationKind = "api_key"
	projections := &authorizationProjectionStoreStub{projection: AuthorizationProjection{
		AccountID: "account-1", ConnectorKey: "tencent-docs", ConnectionID: "server-connection", State: AuthorizationStateConnected,
		ServerSynchronized: true,
	}}
	binding, err := (AccountRuntimeBindingResolver{Projections: projections}).ResolveRuntimeBinding(context.Background(), RuntimeBindingRequest{
		Scope: OperationScope{AccountID: "account-1"}, Connector: Connector{Key: "tencent-docs"}, Release: release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !binding.Enabled || binding.ConnectionID != AccountRuntimeConnectionID("account-1", "tencent-docs") || len(binding.CredentialBrokerGrant) != 0 {
		t.Fatalf("binding = %#v", binding)
	}
}

func TestAccountRuntimeBindingResolverFailsClosedUntilRemoteSnapshotIsFresh(t *testing.T) {
	release := testReleaseWithImplementation("tencent-docs", "1.0.0", ImplementationKindRemoteStreamableHTTP)
	release.Manifest.Implementation = Implementation{Kind: ImplementationKindRemoteStreamableHTTP, RemoteStreamableHTTP: &RemoteStreamableHTTPImplementation{
		ProtocolVersion: "2026-07-28", BindingRef: "tencent-docs.primary", ContractVersion: 1,
		BindingContractHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}}
	release.Manifest.AuthorizationKind = "api_key"
	projection := AuthorizationProjection{AccountID: "account-1", ConnectorKey: "tencent-docs", State: AuthorizationStateConnected}
	projections := &authorizationProjectionStoreStub{projection: projection}
	readiness := NewAuthorizationReadinessGate()
	resolver := AccountRuntimeBindingResolver{Projections: projections, Readiness: readiness}
	request := RuntimeBindingRequest{Scope: OperationScope{AccountID: "account-1"}, Connector: Connector{Key: "tencent-docs"}, Release: release}

	if binding, err := resolver.ResolveRuntimeBinding(context.Background(), request); err != nil || binding.Enabled {
		t.Fatalf("unsynchronized binding = %#v, %v", binding, err)
	}
	readiness.SetReady("account-1", true)
	if binding, err := resolver.ResolveRuntimeBinding(context.Background(), request); err != nil || binding.Enabled {
		t.Fatalf("legacy projection binding = %#v, %v", binding, err)
	}
	projections.projection.ServerSynchronized = true
	if binding, err := resolver.ResolveRuntimeBinding(context.Background(), request); err != nil || !binding.Enabled ||
		binding.ConnectionID != AccountRuntimeConnectionID("account-1", "tencent-docs") {
		t.Fatalf("fresh binding = %#v, %v", binding, err)
	}
}

func TestAccountRuntimeBindingResolverUsesDeviceBindingForNoAuthConnector(t *testing.T) {
	release := testReleaseWithImplementation("github", "1.0.0", ImplementationKindManagedStdio)
	binding, err := (AccountRuntimeBindingResolver{}).ResolveRuntimeBinding(context.Background(), RuntimeBindingRequest{
		Connector: Connector{Key: "github"}, Release: release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !binding.Enabled || binding.ConnectionID != "device-github" {
		t.Fatalf("binding = %#v", binding)
	}
}

func TestAccountRuntimeBindingResolverRequiresAccountForNoAuthRemoteConnector(t *testing.T) {
	release := testReleaseWithImplementation("public-search", "1.0.0", ImplementationKindRemoteStreamableHTTP)
	release.Manifest.Implementation = Implementation{Kind: ImplementationKindRemoteStreamableHTTP,
		RemoteStreamableHTTP: &RemoteStreamableHTTPImplementation{ProtocolVersion: "2026-07-28"}}
	resolver := AccountRuntimeBindingResolver{}
	request := RuntimeBindingRequest{Connector: Connector{Key: "public-search"}, Release: release}
	binding, err := resolver.ResolveRuntimeBinding(context.Background(), request)
	if err != nil || binding.Enabled {
		t.Fatalf("signed-out binding = %#v, %v", binding, err)
	}
	request.Scope = OperationScope{AccountID: "account-1"}
	binding, err = resolver.ResolveRuntimeBinding(context.Background(), request)
	if err != nil || !binding.Enabled || binding.ConnectionID != AccountRuntimeConnectionID("account-1", "public-search") {
		t.Fatalf("signed-in binding = %#v, %v", binding, err)
	}
}

type authorizationProjectionStoreStub struct {
	projection AuthorizationProjection
}

func (store *authorizationProjectionStoreStub) AuthorizationProjection(context.Context, string, string) (AuthorizationProjection, error) {
	return store.projection, nil
}

func (*authorizationProjectionStoreStub) SaveAuthorizationProjection(context.Context, AuthorizationProjection) error {
	return nil
}

type credentialGrantIssuerStub struct {
	grant []byte
	calls int
}

func (issuer *credentialGrantIssuerStub) IssueCredentialBrokerGrant(context.Context, string, string, string) ([]byte, error) {
	issuer.calls++
	return issuer.grant, nil
}
