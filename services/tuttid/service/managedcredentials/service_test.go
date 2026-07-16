package managedcredentials

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	managedcredentialsbiz "github.com/tutti-os/tutti/services/tuttid/biz/managedcredentials"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
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

func TestServiceDefaultsAppGrantToUsableModelPlans(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	store := newManagedCredentialsMemoryStore()
	store.plans["workspace-1:plan-1"] = readyManagedCredentialPlan(
		"workspace-1", "plan-1", "OpenAI Plan", "plan-secret", "gpt-5.5",
	)
	service := &Service{
		Store: store,
		Plans: store,
		Now:   func() time.Time { return now },
	}

	grant, err := service.CreateGrant(ctx, CreateGrantInput{
		ContextToken: "context-token",
		WorkspaceID:  "workspace-1",
		AppID:        "app-1",
		Nonce:        "nonce-1",
		ProviderIDs:  []string{"openai"},
		Scopes:       []string{"model:invoke"},
		State:        "state-1",
	})
	if err != nil {
		t.Fatalf("CreateGrant: %v", err)
	}
	if len(grant.Grant.ProviderIDs) != 0 || len(grant.Grant.ModelPlanIDs) != 1 || grant.Grant.ModelPlanIDs[0] != "plan-1" {
		t.Fatalf("grant routes = providers %#v plans %#v", grant.Grant.ProviderIDs, grant.Grant.ModelPlanIDs)
	}
	if len(grant.Models) != 1 || grant.Models[0].ModelPlanID != "plan-1" || grant.Models[0].ModelPlanName != "OpenAI Plan" {
		t.Fatalf("grant models = %#v", grant.Models)
	}

	credential, err := service.Credential(ctx, CredentialInput{
		WorkspaceID: "workspace-1",
		AppID:       "app-1",
		GrantRef:    grant.Grant.GrantRef,
		Provider:    "openai",
		Model:       "gpt-5.5",
		Capability:  "agent",
	})
	if err != nil {
		t.Fatalf("Credential: %v", err)
	}
	if credential.Credential.APIKey != "plan-secret" || credential.Credential.ModelPlanID != "plan-1" {
		t.Fatalf("credential = %#v", credential.Credential)
	}

	references, err := service.ListModelPlanReferences(ctx, "workspace-1", "plan-1")
	if err != nil {
		t.Fatalf("ListModelPlanReferences: %v", err)
	}
	if len(references) != 1 || references[0].Kind != modelplanbiz.ReferenceWorkspaceApp || references[0].ID != "app-1" {
		t.Fatalf("references = %#v", references)
	}
}

func TestServiceRequiresPlanIdentityForAmbiguousAppCredential(t *testing.T) {
	ctx := context.Background()
	store := newManagedCredentialsMemoryStore()
	store.plans["workspace-1:plan-1"] = readyManagedCredentialPlan(
		"workspace-1", "plan-1", "Plan One", "secret-one", "gpt-shared",
	)
	store.plans["workspace-1:plan-2"] = readyManagedCredentialPlan(
		"workspace-1", "plan-2", "Plan Two", "secret-two", "gpt-shared",
	)
	service := &Service{Store: store, Plans: store}
	grant, err := service.CreateGrant(ctx, CreateGrantInput{
		ContextToken: "context-token",
		WorkspaceID:  "workspace-1",
		AppID:        "app-1",
		Nonce:        "nonce-1",
		ModelPlanIDs: []string{"plan-1", "plan-2"},
		State:        "state-1",
	})
	if err != nil {
		t.Fatalf("CreateGrant: %v", err)
	}
	input := CredentialInput{
		WorkspaceID: "workspace-1",
		AppID:       "app-1",
		GrantRef:    grant.Grant.GrantRef,
		Provider:    "openai",
		Model:       "gpt-shared",
		Capability:  "agent",
	}
	if _, err := service.Credential(ctx, input); !errors.Is(err, ErrModelPlanSelectionRequired) {
		t.Fatalf("Credential without plan error = %v", err)
	}
	input.ModelPlanID = "plan-2"
	credential, err := service.Credential(ctx, input)
	if err != nil {
		t.Fatalf("Credential with plan: %v", err)
	}
	if credential.Credential.APIKey != "secret-two" {
		t.Fatalf("credential API key = %q", credential.Credential.APIKey)
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

func TestServiceListProvidersReturnsEmptyModelArrayAndRedactsSavedAPIKey(t *testing.T) {
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
	if providers[0].APIKey != "" {
		t.Fatalf("provider APIKey = %q, want redacted key", providers[0].APIKey)
	}
	if !providers[0].HasAPIKey {
		t.Fatal("provider HasAPIKey = false, want true")
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
	plans     map[string]modelplanbiz.Plan
	providers map[string]managedcredentialsbiz.ProviderConfig
}

func newManagedCredentialsMemoryStore() *managedCredentialsMemoryStore {
	return &managedCredentialsMemoryStore{
		grants:    map[string]managedcredentialsbiz.Grant{},
		plans:     map[string]modelplanbiz.Plan{},
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

func (s *managedCredentialsMemoryStore) ListManagedModelGrants(_ context.Context, workspaceID string) ([]managedcredentialsbiz.Grant, error) {
	grants := []managedcredentialsbiz.Grant{}
	for _, grant := range s.grants {
		if grant.WorkspaceID == workspaceID {
			grants = append(grants, grant)
		}
	}
	return grants, nil
}

func (s *managedCredentialsMemoryStore) GetModelPlan(_ context.Context, workspaceID string, planID string) (modelplanbiz.Plan, error) {
	plan, ok := s.plans[workspaceID+":"+planID]
	if !ok {
		return modelplanbiz.Plan{}, workspacedata.ErrModelPlanNotFound
	}
	return plan, nil
}

func (s *managedCredentialsMemoryStore) ListModelPlans(_ context.Context, workspaceID string) ([]modelplanbiz.Plan, error) {
	plans := []modelplanbiz.Plan{}
	for _, plan := range s.plans {
		if plan.WorkspaceID == workspaceID {
			plans = append(plans, plan)
		}
	}
	return plans, nil
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

func readyManagedCredentialPlan(workspaceID string, planID string, name string, apiKey string, modelID string) modelplanbiz.Plan {
	checkedAt := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	stages := make([]modelplanbiz.StageResult, 0, 4)
	for _, stage := range []modelplanbiz.DetectionStage{
		modelplanbiz.StageNetwork,
		modelplanbiz.StageAuth,
		modelplanbiz.StageModelDiscovery,
		modelplanbiz.StageInference,
	} {
		stages = append(stages, modelplanbiz.StageResult{
			Stage:     stage,
			Status:    modelplanbiz.StagePassed,
			CheckedAt: checkedAt,
		})
	}
	return modelplanbiz.Plan{
		ID:           planID,
		WorkspaceID:  workspaceID,
		Revision:     1,
		Name:         name,
		TemplateKind: modelplanbiz.TemplateCustom,
		Protocol:     modelplanbiz.ProtocolOpenAI,
		APIKey:       apiKey,
		BaseURL:      "https://example.test/v1",
		Models: []modelplanbiz.Model{{
			ID:   modelID,
			Name: modelID,
			Tier: modelplanbiz.ModelTierStandard,
		}},
		DefaultModel: modelID,
		Enabled:      true,
		Detection: modelplanbiz.DetectionSnapshot{
			Stages:    stages,
			CheckedAt: checkedAt,
			Model:     modelID,
		},
		FirstUse: modelplanbiz.FirstUse{
			Status:      modelplanbiz.FirstUseCompleted,
			CompletedAt: checkedAt,
			Model:       modelID,
		},
		CreatedAt: checkedAt,
		UpdatedAt: checkedAt,
	}
}
