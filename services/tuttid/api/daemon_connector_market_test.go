package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

type stubConnectorMarketService struct {
	market.Service
	snapshotFn   func(context.Context) (market.Snapshot, error)
	categoriesFn func(context.Context) ([]market.CatalogCategory, error)
	pageFn       func(context.Context, market.CatalogPageQuery) (market.CatalogPage, error)
	installFn    func(context.Context, market.ConnectorMutation) (market.MutationResult, error)
	uninstallFn  func(context.Context, market.ConnectorMutation) (market.MutationResult, error)
	refreshFn    func(context.Context, market.Mutation) (market.MutationResult, error)
	operationFn  func(context.Context, market.OperationScope, string) (market.Operation, error)
	cancelFn     func(context.Context, market.OperationScope, string) error
	projectionFn func(context.Context, string, string) (market.AuthorizationProjection, error)
}

func (service stubConnectorMarketService) CancelAuthorization(ctx context.Context, scope market.OperationScope, connectorKey string) error {
	if service.cancelFn == nil {
		return nil
	}
	return service.cancelFn(ctx, scope, connectorKey)
}

func (service stubConnectorMarketService) GetAuthorizationProjection(ctx context.Context, accountID, connectorKey string) (market.AuthorizationProjection, error) {
	if service.projectionFn == nil {
		return market.AuthorizationProjection{}, market.ErrNotFound
	}
	return service.projectionFn(ctx, accountID, connectorKey)
}

func (service stubConnectorMarketService) Snapshot(ctx context.Context) (market.Snapshot, error) {
	return service.snapshotFn(ctx)
}

func (service stubConnectorMarketService) Install(ctx context.Context, mutation market.ConnectorMutation) (market.MutationResult, error) {
	return service.installFn(ctx, mutation)
}

func (service stubConnectorMarketService) Uninstall(ctx context.Context, mutation market.ConnectorMutation) (market.MutationResult, error) {
	return service.uninstallFn(ctx, mutation)
}

func (service stubConnectorMarketService) RefreshCatalog(ctx context.Context, mutation market.Mutation) (market.MutationResult, error) {
	return service.refreshFn(ctx, mutation)
}

func (service stubConnectorMarketService) GetOperationForScope(
	ctx context.Context,
	scope market.OperationScope,
	operationID string,
) (market.Operation, error) {
	return service.operationFn(ctx, scope, operationID)
}

func (service stubConnectorMarketService) ListCatalogCategories(ctx context.Context) ([]market.CatalogCategory, error) {
	return service.categoriesFn(ctx)
}

func (service stubConnectorMarketService) ListCatalogPage(ctx context.Context, query market.CatalogPageQuery) (market.CatalogPage, error) {
	return service.pageFn(ctx, query)
}

func TestDaemonAPIConnectorMarketSnapshotHidesImplementationConfig(t *testing.T) {
	service := stubConnectorMarketService{
		snapshotFn: func(_ context.Context) (market.Snapshot, error) {
			return market.Snapshot{
				CatalogState:   market.CatalogStateReady,
				Connectors:     []market.Connector{connectorMarketTestConnector()},
				Operations:     []market.Operation{},
				Revision:       7,
				SourceRevision: "sha256:catalog",
			}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{ConnectorMarketService: service}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/connector-market", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var raw map[string]any
	decodeGeneratedRouteResponse(t, recorder, &raw)
	connectors := raw["connectors"].([]any)
	connector := connectors[0].(map[string]any)
	release := connector["release"].(map[string]any)
	manifest := release["manifest"].(map[string]any)
	implementation := manifest["implementation"].(map[string]any)
	if _, exists := implementation["config"]; exists {
		t.Fatalf("public implementation leaked config: %#v", implementation)
	}
	if implementation["kind"] != market.ImplementationKindManagedStdio {
		t.Fatalf("implementation.kind = %#v, want managed_stdio", implementation["kind"])
	}
	if manifest["authorizationInteractionMode"] != market.AuthorizationInteractionModeManaged {
		t.Fatalf("authorizationInteractionMode = %#v, want managed", manifest["authorizationInteractionMode"])
	}
	routing := manifest["agentRouting"].(map[string]any)
	aliases := routing["aliases"].([]any)
	if len(aliases) != 2 || aliases[0] != "Notion" || aliases[1] != "Notion AI" {
		t.Fatalf("public agent routing aliases = %#v", aliases)
	}
}

func TestProjectConnectorMarketPreservesRuntimeAuthorizationView(t *testing.T) {
	projected, err := projectConnectorMarket[tuttigenerated.ConnectorMarketAuthorizationResponse](market.AuthorizationResult{
		AuthorizationView: &market.AuthorizationViewEnvelope{
			Protocol: market.AuthorizationViewProtocolV1,
			ViewID:   "authorization-session-1",
			View: market.AuthorizationView{
				Type: market.AuthorizationViewTypeQRCode,
				Source: &market.AuthorizationQRCodeSource{
					Type: market.AuthorizationQRCodeSourcePayload, Value: "opaque-payload",
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if projected.AuthorizationView == nil {
		t.Fatal("runtime authorization view was dropped")
	}
	view, ok := (*projected.AuthorizationView)["view"].(map[string]any)
	if !ok || view["type"] != market.AuthorizationViewTypeQRCode {
		t.Fatalf("projected authorization view = %#v", projected.AuthorizationView)
	}
}

func TestDaemonAPICancelsConnectorAuthorizationForActiveAccount(t *testing.T) {
	var gotScope market.OperationScope
	var gotConnectorKey string
	service := stubConnectorMarketService{cancelFn: func(_ context.Context, scope market.OperationScope, connectorKey string) error {
		gotScope, gotConnectorKey = scope, connectorKey
		return nil
	}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		ConnectorMarketService: service,
		ConnectorMarketScope:   func() market.OperationScope { return market.OperationScope{AccountID: "account-1"} },
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost,
		"/v1/connector-market/connectors/supabase/authorization:cancel", nil)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusNoContent, recorder.Body.String())
	}
	if gotScope.AccountID != "account-1" || gotConnectorKey != "supabase" {
		t.Fatalf("cancel scope=%#v connector=%q", gotScope, gotConnectorKey)
	}
}

func TestDaemonAPIConnectorMarketOverlaysAccountAuthorizationProjection(t *testing.T) {
	service := stubConnectorMarketService{
		snapshotFn: func(context.Context) (market.Snapshot, error) {
			return market.Snapshot{Connectors: []market.Connector{connectorMarketTestConnector()}}, nil
		},
		projectionFn: func(_ context.Context, accountID, connectorKey string) (market.AuthorizationProjection, error) {
			if accountID != "account-1" || connectorKey != "notion" {
				t.Fatalf("projection scope = %q/%q", accountID, connectorKey)
			}
			return market.AuthorizationProjection{AccountID: accountID, ConnectorKey: connectorKey, State: market.AuthorizationStateConnected}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{ConnectorMarketService: service, ConnectorMarketScope: func() market.OperationScope {
		return market.OperationScope{AccountID: "account-1"}
	}}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/connector-market", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Connectors []struct {
			Authorization struct {
				State string `json:"state"`
			} `json:"authorization"`
		} `json:"connectors"`
	}
	decodeGeneratedRouteResponse(t, recorder, &body)
	if len(body.Connectors) != 1 || body.Connectors[0].Authorization.State != string(market.AuthorizationStateConnected) {
		t.Fatalf("body = %#v", body)
	}
}

func TestDaemonAPIRemoteAuthorizationProjectionIsDisconnectedUntilSnapshotReady(t *testing.T) {
	connector := connectorMarketTestConnector()
	connector.Release.Manifest.Implementation = market.Implementation{Kind: market.ImplementationKindRemoteStreamableHTTP,
		RemoteStreamableHTTP: &market.RemoteStreamableHTTPImplementation{ProtocolVersion: "2026-07-28"}}
	service := stubConnectorMarketService{projectionFn: func(context.Context, string, string) (market.AuthorizationProjection, error) {
		return market.AuthorizationProjection{AccountID: "account-1", ConnectorKey: connector.Key, State: market.AuthorizationStateConnected,
			ServerSynchronized: true}, nil
	}}
	api := DaemonAPI{ConnectorMarketService: service, ConnectorMarketScope: func() market.OperationScope {
		return market.OperationScope{AccountID: "account-1"}
	}, ConnectorAuthorizationReady: func(string) bool { return false }}
	connectors := []market.Connector{connector}
	if err := api.overlayConnectorAuthorizationProjections(context.Background(), connectors); err != nil {
		t.Fatal(err)
	}
	if connectors[0].Authorization.State != market.AuthorizationStateDisconnected {
		t.Fatalf("authorization = %#v", connectors[0].Authorization)
	}
}

func TestDaemonAPIConnectorMarketInstallMapsUnsupportedImplementation(t *testing.T) {
	service := stubConnectorMarketService{
		installFn: func(_ context.Context, mutation market.ConnectorMutation) (market.MutationResult, error) {
			if mutation.ConnectorKey != "notion" || mutation.ClientRequestID != "request-1" || mutation.ExpectedRevision != 7 {
				t.Fatalf("mutation = %#v", mutation)
			}
			return market.MutationResult{}, market.NewDomainError(
				market.ErrorCodeUnsupportedImplementation,
				"connector implementation is not registered",
				false,
				nil,
			)
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{ConnectorMarketService: service}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/connector-market/connectors/notion:install", map[string]any{
		"clientRequestId":  "request-1",
		"expectedRevision": 7,
	})
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusUnprocessableEntity, recorder.Body.String())
	}
	var response tuttigenerated.ConnectorMarketError
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Code != tuttigenerated.ConnectorImplementationUnsupported || response.Retryable {
		t.Fatalf("response = %#v", response)
	}
}

func TestDaemonAPIConnectorMarketUninstallPreservesMutationScope(t *testing.T) {
	now := time.Date(2026, time.August, 11, 0, 0, 0, 0, time.UTC)
	service := stubConnectorMarketService{
		uninstallFn: func(_ context.Context, mutation market.ConnectorMutation) (market.MutationResult, error) {
			if mutation.ConnectorKey != "notion" || mutation.ClientRequestID != "request-uninstall-1" ||
				mutation.ExpectedRevision != 7 || mutation.AccountID != "account-1" {
				t.Fatalf("mutation = %#v", mutation)
			}
			return market.MutationResult{
				Operation: market.Operation{
					OperationID: "operation-uninstall-1", ClientRequestID: mutation.ClientRequestID,
					ConnectorKey: mutation.ConnectorKey, Kind: market.OperationKindUninstall,
					State: market.OperationStateAccepted, Stage: market.OperationStageAccepted,
					CreatedAt: now, UpdatedAt: now,
				},
				Revision: 8,
			}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		ConnectorMarketService: service,
		ConnectorMarketScope: func() market.OperationScope {
			return market.OperationScope{AccountID: "account-1"}
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/connector-market/connectors/notion:uninstall", map[string]any{
		"clientRequestId":  "request-uninstall-1",
		"expectedRevision": 7,
	})
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusAccepted, recorder.Body.String())
	}
	var response tuttigenerated.ConnectorMarketMutationResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Operation.Kind != tuttigenerated.Uninstall || response.Revision != 8 {
		t.Fatalf("response = %#v", response)
	}
}

func TestDaemonAPIConnectorMarketRefreshRejectsNegativeRevision(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{ConnectorMarketService: stubConnectorMarketService{}}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/connector-market:refresh", map[string]any{
		"clientRequestId":  "request-1",
		"expectedRevision": -1,
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
}

func TestDaemonAPIConnectorMarketRefreshBindsActiveAccount(t *testing.T) {
	service := stubConnectorMarketService{refreshFn: func(_ context.Context, mutation market.Mutation) (market.MutationResult, error) {
		if mutation.Scope.AccountID != "account-a" || mutation.ClientRequestID != "request-refresh" {
			t.Fatalf("refresh mutation = %#v", mutation)
		}
		return market.MutationResult{Operation: market.Operation{
			OperationID: "refresh-1", ClientRequestID: mutation.ClientRequestID, Kind: market.OperationKindRefreshCatalog,
			Scope: mutation.Scope, State: market.OperationStateAccepted, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
		}}, nil
	}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		ConnectorMarketService: service,
		ConnectorMarketScope:   func() market.OperationScope { return market.OperationScope{AccountID: "account-a"} },
	}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/connector-market:refresh", map[string]any{
		"clientRequestId": "request-refresh", "expectedRevision": 0,
	})
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d; body: %s", recorder.Code, recorder.Body.String())
	}
}

func TestDaemonAPIConnectorMarketOperationUsesScopedRead(t *testing.T) {
	service := stubConnectorMarketService{operationFn: func(_ context.Context, scope market.OperationScope, operationID string) (market.Operation, error) {
		if scope.AccountID != "account-b" || operationID != "operation-a" {
			t.Fatalf("operation scope=%#v id=%q", scope, operationID)
		}
		return market.Operation{}, market.ErrNotFound
	}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		ConnectorMarketService: service,
		ConnectorMarketScope:   func() market.OperationScope { return market.OperationScope{AccountID: "account-b"} },
	}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/connector-market/operations/operation-a", nil)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body: %s", recorder.Code, recorder.Body.String())
	}
}

func TestDaemonAPIConnectorMarketServesCategoriesAndCursorPage(t *testing.T) {
	service := stubConnectorMarketService{
		categoriesFn: func(context.Context) ([]market.CatalogCategory, error) {
			return []market.CatalogCategory{{CategoryID: "development", Kind: "category", SortOrder: 20, ItemCount: 1}}, nil
		},
		pageFn: func(_ context.Context, query market.CatalogPageQuery) (market.CatalogPage, error) {
			if query.SectionID != "development" || query.PageSize != 20 || query.PageToken != "cursor-1" ||
				query.InstallationFilter != market.CatalogInstallationFilterNotInstalled {
				t.Fatalf("query = %#v", query)
			}
			return market.CatalogPage{
				SectionID:     "development",
				Items:         []market.CatalogListing{{CategoryID: "development", Connector: connectorMarketTestConnector()}},
				NextPageToken: "cursor-2",
				Revision:      8,
			}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{ConnectorMarketService: service}))

	categories := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/connector-market/categories", nil)
	if categories.Code != http.StatusOK {
		t.Fatalf("categories status = %d; body: %s", categories.Code, categories.Body.String())
	}
	page := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/connector-market/catalog?sectionId=development&installation=not_installed&pageSize=20&pageToken=cursor-1", nil)
	if page.Code != http.StatusOK {
		t.Fatalf("page status = %d; body: %s", page.Code, page.Body.String())
	}
	var response tuttigenerated.ConnectorMarketCatalogPage
	decodeGeneratedRouteResponse(t, page, &response)
	if response.SectionId != "development" || response.Revision != 8 || len(response.Items) != 1 || response.Items[0].Connector.Key != "notion" {
		t.Fatalf("response = %#v", response)
	}
}

func TestDaemonAPIConnectorMarketEmptyCatalogPageUsesEmptyItemsArray(t *testing.T) {
	service := stubConnectorMarketService{
		pageFn: func(context.Context, market.CatalogPageQuery) (market.CatalogPage, error) {
			return market.CatalogPage{SectionID: "featured", Revision: 8}, nil
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{ConnectorMarketService: service}))

	page := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/connector-market/catalog?sectionId=featured&pageSize=20", nil)
	if page.Code != http.StatusOK {
		t.Fatalf("page status = %d; body: %s", page.Code, page.Body.String())
	}
	var raw map[string]any
	decodeGeneratedRouteResponse(t, page, &raw)
	items, ok := raw["items"].([]any)
	if !ok || items == nil {
		t.Fatalf("items = %#v, want an empty JSON array", raw["items"])
	}
	if len(items) != 0 {
		t.Fatalf("items = %#v, want empty", items)
	}
}

func connectorMarketTestConnector() market.Connector {
	digest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	return market.Connector{
		Key: "notion",
		Release: market.Release{
			SchemaVersion:  "1",
			ReleaseID:      "notion@1.0.0",
			ConnectorKey:   "notion",
			Version:        "1.0.0",
			ReleaseDigest:  digest,
			ManifestDigest: digest,
			Manifest: market.Manifest{
				IconURL:       "data:image/png;base64,iVBORw0KGgo=",
				SchemaVersion: "1",
				DisplayName:   "Notion",
				AgentRouting:  &market.AgentRouting{Aliases: []string{"Notion", "Notion AI"}},
				Permissions:   []string{"pages.read"},
				Implementation: market.Implementation{
					Kind: market.ImplementationKindManagedStdio,
					ManagedStdio: &market.ManagedStdioImplementation{
						Runtime: market.RuntimeRequirement{Language: "node", Profile: "connector-node-static", ABI: "node20-darwin-arm64", VersionRange: ">=20.0.0 <21.0.0"},
						CLI: &market.ManagedCLIInterface{Entrypoint: "notion", TimeoutMS: 120_000,
							Commands: []market.CLICommand{{Name: "run", InputSchema: map[string]any{"type": "object"}, TimeoutMS: 30_000}}},
						CredentialBroker: &market.ManagedCredentialBroker{Protocol: market.CredentialBrokerProtocolV1,
							Entrypoint: "authorization/broker.mjs", TimeoutMS: 300_000, AllowedHosts: []string{"notion.so"}},
					},
				},
				AuthorizationKind: "oauth2",
			},
			Artifact: market.Artifact{
				Key:       "connectors/notion/1.0.0.tar.gz",
				SHA256:    digest,
				SizeBytes: 128,
				MediaType: "application/gzip",
			},
			PublishedAt: time.Date(2026, time.August, 3, 0, 0, 0, 0, time.UTC), Status: market.ReleaseStatusAvailable,
		},
		Installation:  market.Installation{State: market.InstallationStateNotInstalled},
		Authorization: market.Authorization{State: market.AuthorizationStateDisconnected},
		Compatibility: market.Compatibility{State: market.CompatibilityStateSupported},
		Revision:      7,
	}
}
