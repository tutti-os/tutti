package managedcredentials

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	managedcredentialsbiz "github.com/tutti-os/tutti/services/tuttid/biz/managedcredentials"
)

func TestServiceGrantCodeIsOneTimeAndGrantRefRefreshes(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	store := newManagedCredentialsMemoryStore()
	service := &Service{
		Store: store,
		Now: func() time.Time {
			return now
		},
	}
	apiKey := "agnes-secret"
	if _, err := service.PutProvider(ctx, PutProviderInput{
		WorkspaceID: "workspace-1",
		Provider:    "agnes",
		Enabled:     true,
		APIKey:      &apiKey,
		BaseURL:     "https://agnes.example/v1",
		Models: []managedcredentialsbiz.Model{{
			ID:       "agnes-2.0-flash",
			Name:     "Agnes 2.0 Flash",
			Provider: managedcredentialsbiz.ProviderAgnes,
		}},
	}); err != nil {
		t.Fatalf("PutProvider: %v", err)
	}

	grant, err := service.CreateGrant(ctx, CreateGrantInput{
		ContextToken: "context-token",
		WorkspaceID:  "workspace-1",
		AppID:        "app-1",
		Nonce:        "nonce-1",
		ProviderIDs:  []string{"agnes"},
		Scopes:       []string{"models:use"},
		State:        "state-1",
	})
	if err != nil {
		t.Fatalf("CreateGrant: %v", err)
	}

	firstExchange, err := service.Exchange(ctx, ExchangeInput{
		ContextToken: "context-token",
		WorkspaceID:  "workspace-1",
		AppID:        "app-1",
		GrantCode:    grant.GrantCode,
		Nonce:        "nonce-1",
		State:        "state-1",
	})
	if err != nil {
		t.Fatalf("first Exchange: %v", err)
	}
	if firstExchange.GrantRef != grant.Grant.GrantRef {
		t.Fatalf("first Exchange grantRef = %q, want %q", firstExchange.GrantRef, grant.Grant.GrantRef)
	}
	if firstExchange.Providers[0] != managedcredentialsbiz.ProviderAgnes {
		t.Fatalf("first Exchange provider = %q, want agnes", firstExchange.Providers[0])
	}
	credential, err := service.Credential(ctx, CredentialInput{
		WorkspaceID: "workspace-1",
		AppID:       "app-1",
		GrantRef:    firstExchange.GrantRef,
		Provider:    "agnes",
		Model:       "agnes-2.0-flash",
		Capability:  "agent",
	})
	if err != nil {
		t.Fatalf("Credential: %v", err)
	}
	if got := credential.Credential.APIKey; got != "agnes-secret" {
		t.Fatalf("Credential API key = %q", got)
	}

	if _, err := service.Exchange(ctx, ExchangeInput{
		ContextToken: "context-token",
		WorkspaceID:  "workspace-1",
		AppID:        "app-1",
		GrantCode:    grant.GrantCode,
		Nonce:        "nonce-1",
		State:        "state-1",
	}); !errors.Is(err, ErrGrantCodeInvalid) {
		t.Fatalf("second Exchange with same code error = %v, want %v", err, ErrGrantCodeInvalid)
	}

	// Within the grant lease the grantRef can be reused, but the reported
	// expiry stays pinned to the original lease rather than rolling forward.
	now = now.Add(1 * time.Hour)
	refreshCatalog, err := service.ListGrantModels(ctx,
		"workspace-1",
		"app-1",
		grant.Grant.GrantRef,
	)
	if err != nil {
		t.Fatalf("refresh ListGrantModels: %v", err)
	}
	if !refreshCatalog.ExpiresAt.Equal(grant.Grant.ExpiresAt) {
		t.Fatalf("refresh expiry = %s, want fixed grant expiry %s", refreshCatalog.ExpiresAt, grant.Grant.ExpiresAt)
	}
	refreshCredential, err := service.Credential(ctx, CredentialInput{
		WorkspaceID: "workspace-1",
		AppID:       "app-1",
		GrantRef:    grant.Grant.GrantRef,
		Provider:    "agnes",
		Model:       "agnes-2.0-flash",
		Capability:  "agent",
	})
	if err != nil {
		t.Fatalf("refresh Credential: %v", err)
	}
	if !refreshCredential.ExpiresAt.Equal(grant.Grant.ExpiresAt) {
		t.Fatalf("credential expiry = %s, want fixed grant expiry %s", refreshCredential.ExpiresAt, grant.Grant.ExpiresAt)
	}
}

func TestServiceRejectsExpiredGrant(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	store := newManagedCredentialsMemoryStore()
	service := &Service{
		Store: store,
		Now: func() time.Time {
			return now
		},
	}
	apiKey := "agnes-secret"
	if _, err := service.PutProvider(ctx, PutProviderInput{
		WorkspaceID: "workspace-1",
		Provider:    "agnes",
		Enabled:     true,
		APIKey:      &apiKey,
		BaseURL:     "https://agnes.example/v1",
		Models: []managedcredentialsbiz.Model{{
			ID:       "agnes-2.0-flash",
			Name:     "Agnes 2.0 Flash",
			Provider: managedcredentialsbiz.ProviderAgnes,
		}},
	}); err != nil {
		t.Fatalf("PutProvider: %v", err)
	}

	grant, err := service.CreateGrant(ctx, CreateGrantInput{
		ContextToken: "context-token",
		WorkspaceID:  "workspace-1",
		AppID:        "app-1",
		Nonce:        "nonce-1",
		ProviderIDs:  []string{"agnes"},
		Scopes:       []string{"models:use"},
		State:        "state-1",
	})
	if err != nil {
		t.Fatalf("CreateGrant: %v", err)
	}

	// Exchange the one-time code within the lease so we hold a live grantRef.
	if _, err := service.Exchange(ctx, ExchangeInput{
		ContextToken: "context-token",
		WorkspaceID:  "workspace-1",
		AppID:        "app-1",
		GrantCode:    grant.GrantCode,
		Nonce:        "nonce-1",
		State:        "state-1",
	}); err != nil {
		t.Fatalf("Exchange: %v", err)
	}

	// Advancing past the lease must stop the grantRef from minting credentials.
	now = now.Add(GrantCodeTTL + time.Second)

	if _, err := service.Credential(ctx, CredentialInput{
		WorkspaceID: "workspace-1",
		AppID:       "app-1",
		GrantRef:    grant.Grant.GrantRef,
		Provider:    "agnes",
		Model:       "agnes-2.0-flash",
		Capability:  "agent",
	}); !errors.Is(err, ErrGrantExpired) {
		t.Fatalf("Credential after expiry error = %v, want %v", err, ErrGrantExpired)
	}

	if _, err := service.ListGrantModels(ctx, "workspace-1", "app-1", grant.Grant.GrantRef); !errors.Is(err, ErrGrantExpired) {
		t.Fatalf("ListGrantModels after expiry error = %v, want %v", err, ErrGrantExpired)
	}
}

func TestServiceRejectsExpiredGrantCode(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	store := newManagedCredentialsMemoryStore()
	service := &Service{
		Store: store,
		Now: func() time.Time {
			return now
		},
	}
	grant, err := service.CreateGrant(ctx, CreateGrantInput{
		ContextToken: "context-token",
		WorkspaceID:  "workspace-1",
		AppID:        "app-1",
		Nonce:        "nonce-1",
		ProviderIDs:  []string{"agnes"},
		State:        "state-1",
	})
	if err != nil {
		t.Fatalf("CreateGrant: %v", err)
	}

	now = now.Add(GrantCodeTTL + time.Second)
	_, err = service.Exchange(ctx, ExchangeInput{
		ContextToken: "context-token",
		WorkspaceID:  "workspace-1",
		AppID:        "app-1",
		GrantCode:    grant.GrantCode,
		Nonce:        "nonce-1",
		State:        "state-1",
	})
	if !errors.Is(err, ErrGrantCodeInvalid) {
		t.Fatalf("Exchange error = %v, want %v", err, ErrGrantCodeInvalid)
	}
}

func TestServiceRejectsGrantCodeWithMismatchedChallengeContext(t *testing.T) {
	ctx := context.Background()
	store := newManagedCredentialsMemoryStore()
	service := &Service{Store: store}
	grant, err := service.CreateGrant(ctx, CreateGrantInput{
		ContextToken: "context-token",
		WorkspaceID:  "workspace-1",
		AppID:        "app-1",
		Nonce:        "nonce-1",
		ProviderIDs:  []string{"agnes"},
		State:        "state-1",
	})
	if err != nil {
		t.Fatalf("CreateGrant: %v", err)
	}

	_, err = service.Exchange(ctx, ExchangeInput{
		ContextToken: "different-context-token",
		WorkspaceID:  "workspace-1",
		AppID:        "app-1",
		GrantCode:    grant.GrantCode,
		Nonce:        "nonce-1",
		State:        "state-1",
	})
	if !errors.Is(err, ErrGrantCodeInvalid) {
		t.Fatalf("Exchange error = %v, want %v", err, ErrGrantCodeInvalid)
	}
}

func TestServicePutProviderPreservesOmittedAPIKeyAndClearsBlankAPIKey(t *testing.T) {
	ctx := context.Background()
	store := newManagedCredentialsMemoryStore()
	service := &Service{Store: store}
	apiKey := "agnes-secret"
	if _, err := service.PutProvider(ctx, PutProviderInput{
		WorkspaceID: "workspace-1",
		Provider:    "agnes",
		Enabled:     true,
		APIKey:      &apiKey,
		BaseURL:     "https://agnes.example/v1",
	}); err != nil {
		t.Fatalf("initial PutProvider: %v", err)
	}
	if _, err := service.PutProvider(ctx, PutProviderInput{
		WorkspaceID: "workspace-1",
		Provider:    "agnes",
		Enabled:     true,
		BaseURL:     "https://agnes-alt.example/v1",
	}); err != nil {
		t.Fatalf("second PutProvider: %v", err)
	}
	config, err := store.GetManagedModelProviderConfig(ctx, "workspace-1", managedcredentialsbiz.ProviderAgnes)
	if err != nil {
		t.Fatalf("GetManagedModelProviderConfig: %v", err)
	}
	if config.APIKey != apiKey {
		t.Fatalf("APIKey = %q, want preserved key", config.APIKey)
	}

	blankAPIKey := " "
	if _, err := service.PutProvider(ctx, PutProviderInput{
		WorkspaceID: "workspace-1",
		Provider:    "agnes",
		Enabled:     true,
		APIKey:      &blankAPIKey,
		BaseURL:     "https://agnes-empty-key.example/v1",
	}); err != nil {
		t.Fatalf("blank-key PutProvider: %v", err)
	}
	config, err = store.GetManagedModelProviderConfig(ctx, "workspace-1", managedcredentialsbiz.ProviderAgnes)
	if err != nil {
		t.Fatalf("GetManagedModelProviderConfig after blank key: %v", err)
	}
	if config.APIKey != "" {
		t.Fatalf("APIKey after blank key = %q, want cleared key", config.APIKey)
	}
}

func TestServiceListProvidersReturnsEmptyModelArrayAndSavedAPIKey(t *testing.T) {
	ctx := context.Background()
	store := newManagedCredentialsMemoryStore()
	service := &Service{Store: store}
	store.providers["workspace-1:agnes"] = managedcredentialsbiz.ProviderConfig{
		WorkspaceID: "workspace-1",
		Provider:    managedcredentialsbiz.ProviderAgnes,
		Enabled:     true,
		APIKey:      "agnes-secret",
		Models:      nil,
	}

	providers, err := service.ListProviders(ctx, "workspace-1")
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}
	if len(providers) != 1 {
		t.Fatalf("provider count = %d, want 1", len(providers))
	}
	if providers[0].Models == nil {
		t.Fatal("provider Models is nil, want empty slice")
	}
	if len(providers[0].Models) != 0 {
		t.Fatalf("provider Models length = %d, want 0", len(providers[0].Models))
	}
	if providers[0].APIKey != "agnes-secret" {
		t.Fatalf("provider APIKey = %q, want saved key", providers[0].APIKey)
	}
}

func TestServiceListProviderModelsFetchesOpenAICompatibleCatalog(t *testing.T) {
	ctx := context.Background()
	store := newManagedCredentialsMemoryStore()
	var gotPath string
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data": [
				{"id": "agnes-2.0-flash", "name": "Agnes 2.0 Flash"},
				{"id": "agnes-2.0-pro"},
				{"id": "agnes-2.0-flash"},
				{"id": " "}
			]
		}`))
	}))
	defer server.Close()

	service := &Service{
		Store:      store,
		HTTPClient: server.Client(),
	}
	apiKey := "agnes-secret"
	if _, err := service.PutProvider(ctx, PutProviderInput{
		WorkspaceID: "workspace-1",
		Provider:    "agnes",
		Enabled:     true,
		APIKey:      &apiKey,
		BaseURL:     server.URL + "/v1",
	}); err != nil {
		t.Fatalf("PutProvider: %v", err)
	}

	result, err := service.ListProviderModels(ctx, ListProviderModelsInput{
		WorkspaceID: "workspace-1",
		Provider:    "agnes",
	})
	if err != nil {
		t.Fatalf("ListProviderModels: %v", err)
	}
	if gotPath != "/v1/models" {
		t.Fatalf("request path = %q, want /v1/models", gotPath)
	}
	if gotAuth != "Bearer agnes-secret" {
		t.Fatalf("Authorization = %q, want bearer token", gotAuth)
	}
	if len(result.Models) != 2 {
		t.Fatalf("model count = %d, want 2", len(result.Models))
	}
	if result.Models[0].ID != "agnes-2.0-flash" || result.Models[0].Name != "Agnes 2.0 Flash" {
		t.Fatalf("first model = %#v", result.Models[0])
	}
	if result.Models[1].ID != "agnes-2.0-pro" || result.Models[1].Provider != managedcredentialsbiz.ProviderAgnes {
		t.Fatalf("second model = %#v", result.Models[1])
	}
}

func TestServiceListProviderModelsUsesOverrideInput(t *testing.T) {
	ctx := context.Background()
	store := newManagedCredentialsMemoryStore()
	var gotPath string
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"agnes-2.0-pro"}]}`))
	}))
	defer server.Close()

	service := &Service{
		Store:      store,
		HTTPClient: server.Client(),
	}
	apiKey := "unsaved-secret"
	result, err := service.ListProviderModels(ctx, ListProviderModelsInput{
		WorkspaceID: "workspace-1",
		Provider:    "agnes",
		APIKey:      &apiKey,
		BaseURL:     server.URL + "/v1",
	})
	if err != nil {
		t.Fatalf("ListProviderModels: %v", err)
	}
	if gotPath != "/v1/models" {
		t.Fatalf("request path = %q, want /v1/models", gotPath)
	}
	if gotAuth != "Bearer unsaved-secret" {
		t.Fatalf("Authorization = %q, want override bearer token", gotAuth)
	}
	if len(result.Models) != 1 || result.Models[0].ID != "agnes-2.0-pro" {
		t.Fatalf("models = %#v", result.Models)
	}
}

func TestServiceListProviderModelsTriesVersionedBaseModelsFirst(t *testing.T) {
	ctx := context.Background()
	store := newManagedCredentialsMemoryStore()
	var gotPaths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		if r.URL.Path != "/api/coding/paas/v4/models" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"glm-coding"}]}`))
	}))
	defer server.Close()

	service := &Service{
		Store:      store,
		HTTPClient: server.Client(),
	}
	apiKey := "coding-secret"
	result, err := service.ListProviderModels(ctx, ListProviderModelsInput{
		WorkspaceID: "workspace-1",
		Provider:    "openai",
		APIKey:      &apiKey,
		BaseURL:     server.URL + "/api/coding/paas/v4",
	})
	if err != nil {
		t.Fatalf("ListProviderModels: %v", err)
	}
	if len(gotPaths) != 1 || gotPaths[0] != "/api/coding/paas/v4/models" {
		t.Fatalf("request paths = %#v, want first versioned /models", gotPaths)
	}
	if len(result.Models) != 1 || result.Models[0].ID != "glm-coding" {
		t.Fatalf("models = %#v", result.Models)
	}
}

type managedCredentialsMemoryStore struct {
	grants    map[string]managedcredentialsbiz.Grant
	providers map[string]managedcredentialsbiz.ProviderConfig
}

func newManagedCredentialsMemoryStore() *managedCredentialsMemoryStore {
	return &managedCredentialsMemoryStore{
		grants:    map[string]managedcredentialsbiz.Grant{},
		providers: map[string]managedcredentialsbiz.ProviderConfig{},
	}
}

func (*managedCredentialsMemoryStore) DeleteManagedModelGrant(context.Context, string, string, string) error {
	return nil
}

func (s *managedCredentialsMemoryStore) DeleteManagedModelProviderConfig(_ context.Context, workspaceID string, provider managedcredentialsbiz.ProviderID) error {
	delete(s.providers, workspaceID+":"+string(provider))
	return nil
}

func (s *managedCredentialsMemoryStore) GetManagedModelGrant(_ context.Context, workspaceID string, appID string, grantRef string) (managedcredentialsbiz.Grant, error) {
	grant, ok := s.grants[workspaceID+":"+appID+":"+grantRef]
	if !ok {
		return managedcredentialsbiz.Grant{}, errors.New("grant not found")
	}
	return grant, nil
}

func (s *managedCredentialsMemoryStore) GetManagedModelProviderConfig(_ context.Context, workspaceID string, provider managedcredentialsbiz.ProviderID) (managedcredentialsbiz.ProviderConfig, error) {
	config, ok := s.providers[workspaceID+":"+string(provider)]
	if !ok {
		return managedcredentialsbiz.ProviderConfig{}, ErrProviderNotConfigured
	}
	return config, nil
}

func (s *managedCredentialsMemoryStore) ListManagedModelProviderConfigs(_ context.Context, workspaceID string) ([]managedcredentialsbiz.ProviderConfig, error) {
	var configs []managedcredentialsbiz.ProviderConfig
	for _, config := range s.providers {
		if config.WorkspaceID == workspaceID {
			configs = append(configs, config)
		}
	}
	return configs, nil
}

func (s *managedCredentialsMemoryStore) PutManagedModelGrant(_ context.Context, grant managedcredentialsbiz.Grant) error {
	s.grants[grant.WorkspaceID+":"+grant.AppID+":"+grant.GrantRef] = grant
	return nil
}

func (s *managedCredentialsMemoryStore) PutManagedModelProviderConfig(_ context.Context, config managedcredentialsbiz.ProviderConfig) error {
	s.providers[config.WorkspaceID+":"+string(config.Provider)] = config
	return nil
}

func (s *managedCredentialsMemoryStore) RevokeManagedModelGrant(_ context.Context, workspaceID string, appID string, grantRef string) error {
	grant, ok := s.grants[workspaceID+":"+appID+":"+grantRef]
	if !ok {
		return errors.New("grant not found")
	}
	now := time.Now().UTC()
	grant.RevokedAt = &now
	s.grants[workspaceID+":"+appID+":"+grantRef] = grant
	return nil
}
