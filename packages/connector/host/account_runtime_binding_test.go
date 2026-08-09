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
	binding, err = resolver.ResolveRuntimeBinding(context.Background(), RuntimeBindingRequest{
		Scope: OperationScope{AccountID: "account-1"}, Purpose: RuntimeBindingPurposeInstallationProbe,
		Connector: Connector{Key: "github"}, Release: release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !binding.Enabled || len(binding.CredentialBrokerGrant) != 0 || credentials.calls != 1 {
		t.Fatalf("installation probe binding = %#v, credential calls = %d", binding, credentials.calls)
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
