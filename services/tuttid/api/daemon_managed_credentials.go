package api

import (
	"encoding/json"
	"net/http"
	"strings"

	managedcredentialsbiz "github.com/tutti-os/tutti/services/tuttid/biz/managedcredentials"
	managedcredentialsservice "github.com/tutti-os/tutti/services/tuttid/service/managedcredentials"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type managedProviderRequest struct {
	Enabled bool                          `json:"enabled"`
	APIKey  *string                       `json:"apiKey"`
	BaseURL string                        `json:"baseUrl"`
	Models  []managedcredentialsbiz.Model `json:"models"`
}

type managedProviderModelsRequest struct {
	APIKey  *string `json:"apiKey"`
	BaseURL string  `json:"baseUrl"`
}

type managedGrantCreateRequest struct {
	ContextToken string   `json:"contextToken"`
	ModelPlanIDs []string `json:"modelPlanIds"`
	Nonce        string   `json:"nonce"`
	Providers    []string `json:"providers"`
	Scopes       []string `json:"scopes"`
	State        string   `json:"state"`
}

type managedGrantExchangeRequest struct {
	GrantCode      string `json:"grantCode"`
	InstallationID string `json:"installationId"`
	ContextToken   string `json:"contextToken"`
	Nonce          string `json:"nonce"`
	State          string `json:"state"`
}

type managedGrantCredentialRequest struct {
	Capability  string `json:"capability"`
	Model       string `json:"model"`
	ModelPlanID string `json:"modelPlanId"`
	Provider    string `json:"provider"`
}

func (r daemonRoutes) HandleManagedModelProviders(w http.ResponseWriter, req *http.Request, workspaceID string) {
	service := r.api.ManagedCredentialsService
	if service == nil {
		writeManagedCredentialError(w, http.StatusServiceUnavailable, "managed credentials service is unavailable")
		return
	}
	switch req.Method {
	case http.MethodGet:
		providers, err := service.ListProviders(req.Context(), workspaceID)
		if err != nil {
			writeManagedCredentialError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"providers": providers})
	default:
		tuttitypes.WriteMethodNotAllowed(w)
	}
}

func (r daemonRoutes) HandleManagedModelProvider(w http.ResponseWriter, req *http.Request, workspaceID string, providerID string) {
	service := r.api.ManagedCredentialsService
	if service == nil {
		writeManagedCredentialError(w, http.StatusServiceUnavailable, "managed credentials service is unavailable")
		return
	}
	switch req.Method {
	case http.MethodPut:
		var body managedProviderRequest
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			writeManagedCredentialError(w, http.StatusBadRequest, "invalid provider payload")
			return
		}
		provider, err := service.PutProvider(req.Context(), managedcredentialsservice.PutProviderInput{
			WorkspaceID: workspaceID,
			Provider:    providerID,
			Enabled:     body.Enabled,
			APIKey:      body.APIKey,
			BaseURL:     body.BaseURL,
			Models:      body.Models,
		})
		if err != nil {
			writeManagedCredentialError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"provider": provider})
	case http.MethodDelete:
		if err := service.DeleteProvider(req.Context(), workspaceID, providerID); err != nil {
			writeManagedCredentialError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		tuttitypes.WriteMethodNotAllowed(w)
	}
}

func (r daemonRoutes) HandleManagedModelProviderTest(w http.ResponseWriter, req *http.Request, workspaceID string, providerID string) {
	service := r.api.ManagedCredentialsService
	if service == nil {
		writeManagedCredentialError(w, http.StatusServiceUnavailable, "managed credentials service is unavailable")
		return
	}
	if req.Method != http.MethodPost {
		tuttitypes.WriteMethodNotAllowed(w)
		return
	}
	if err := service.TestProvider(req.Context(), workspaceID, providerID); err != nil {
		status := http.StatusBadRequest
		if err == managedcredentialsservice.ErrProviderNotConfigured {
			status = http.StatusConflict
		}
		writeManagedCredentialError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (r daemonRoutes) HandleManagedModelProviderModels(w http.ResponseWriter, req *http.Request, workspaceID string, providerID string) {
	service := r.api.ManagedCredentialsService
	if service == nil {
		writeManagedCredentialError(w, http.StatusServiceUnavailable, "managed credentials service is unavailable")
		return
	}
	if req.Method != http.MethodPost {
		tuttitypes.WriteMethodNotAllowed(w)
		return
	}
	var body managedProviderModelsRequest
	_ = json.NewDecoder(req.Body).Decode(&body)
	result, err := service.ListProviderModels(req.Context(), managedcredentialsservice.ListProviderModelsInput{
		WorkspaceID: workspaceID,
		Provider:    providerID,
		APIKey:      body.APIKey,
		BaseURL:     body.BaseURL,
	})
	if err != nil {
		status := http.StatusBadRequest
		if err == managedcredentialsservice.ErrProviderNotConfigured {
			status = http.StatusConflict
		}
		writeManagedCredentialError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": result.Models})
}

func (r daemonRoutes) HandleManagedModelGrants(w http.ResponseWriter, req *http.Request, workspaceID string, appID string) {
	service := r.api.ManagedCredentialsService
	if service == nil {
		writeManagedCredentialError(w, http.StatusServiceUnavailable, "managed credentials service is unavailable")
		return
	}
	if req.Method != http.MethodPost {
		tuttitypes.WriteMethodNotAllowed(w)
		return
	}
	var body managedGrantCreateRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeManagedCredentialError(w, http.StatusBadRequest, "invalid grant payload")
		return
	}
	result, err := service.CreateGrant(req.Context(), managedcredentialsservice.CreateGrantInput{
		ContextToken: body.ContextToken,
		WorkspaceID:  workspaceID,
		AppID:        appID,
		Nonce:        body.Nonce,
		ProviderIDs:  body.Providers,
		ModelPlanIDs: body.ModelPlanIDs,
		Scopes:       body.Scopes,
		State:        body.State,
	})
	if err != nil {
		writeManagedCredentialError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"grantCode":    result.GrantCode,
		"expiresAt":    result.Grant.ExpiresAt,
		"providers":    result.Grant.ProviderIDs,
		"modelPlanIds": result.Grant.ModelPlanIDs,
		"models":       result.Models,
	})
}

func (r daemonRoutes) HandleManagedModelGrant(w http.ResponseWriter, req *http.Request, workspaceID string, appID string, grantRef string) {
	service := r.api.ManagedCredentialsService
	if service == nil {
		writeManagedCredentialError(w, http.StatusServiceUnavailable, "managed credentials service is unavailable")
		return
	}
	if req.Method != http.MethodDelete {
		tuttitypes.WriteMethodNotAllowed(w)
		return
	}
	if err := service.Revoke(req.Context(), workspaceID, appID, grantRef); err != nil {
		writeManagedCredentialError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (r daemonRoutes) HandleManagedModelGrantModels(w http.ResponseWriter, req *http.Request, workspaceID string, appID string, grantRef string) {
	service := r.api.ManagedCredentialsService
	if service == nil {
		writeManagedCredentialError(w, http.StatusServiceUnavailable, "managed credentials service is unavailable")
		return
	}
	if req.Method != http.MethodGet {
		tuttitypes.WriteMethodNotAllowed(w)
		return
	}
	result, err := service.ListGrantModels(req.Context(), workspaceID, appID, grantRef)
	if err != nil {
		writeManagedCredentialGrantError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"expiresAt": result.ExpiresAt,
		"models":    result.Models,
	})
}

func (r daemonRoutes) HandleManagedModelGrantCredential(w http.ResponseWriter, req *http.Request, workspaceID string, appID string, grantRef string) {
	service := r.api.ManagedCredentialsService
	if service == nil {
		writeManagedCredentialError(w, http.StatusServiceUnavailable, "managed credentials service is unavailable")
		return
	}
	if req.Method != http.MethodPost {
		tuttitypes.WriteMethodNotAllowed(w)
		return
	}
	var body managedGrantCredentialRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeManagedCredentialError(w, http.StatusBadRequest, "invalid credential payload")
		return
	}
	result, err := service.Credential(req.Context(), managedcredentialsservice.CredentialInput{
		WorkspaceID: workspaceID,
		AppID:       appID,
		GrantRef:    grantRef,
		Provider:    body.Provider,
		ModelPlanID: body.ModelPlanID,
		Model:       body.Model,
		Capability:  body.Capability,
	})
	if err != nil {
		writeManagedCredentialGrantError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"expiresAt":  result.ExpiresAt,
		"credential": result.Credential,
		"models":     result.GrantModels,
	})
}

func (r daemonRoutes) HandleManagedModelGrantExchange(w http.ResponseWriter, req *http.Request, workspaceID string, appID string) {
	service := r.api.ManagedCredentialsService
	if service == nil {
		writeManagedCredentialError(w, http.StatusServiceUnavailable, "managed credentials service is unavailable")
		return
	}
	if req.Method != http.MethodPost {
		tuttitypes.WriteMethodNotAllowed(w)
		return
	}
	var body managedGrantExchangeRequest
	_ = json.NewDecoder(req.Body).Decode(&body)
	result, err := service.Exchange(req.Context(), managedcredentialsservice.ExchangeInput{
		ContextToken: body.ContextToken,
		WorkspaceID:  workspaceID,
		AppID:        appID,
		GrantCode:    body.GrantCode,
		Nonce:        body.Nonce,
		State:        body.State,
	})
	if err != nil {
		writeManagedCredentialGrantError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"expiresAt":    result.ExpiresAt,
		"grantRef":     result.GrantRef,
		"providers":    result.Providers,
		"modelPlanIds": result.ModelPlanIDs,
		"models":       result.Models,
	})
}

func writeManagedCredentialGrantError(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	switch err {
	case managedcredentialsservice.ErrGrantCodeInvalid:
		status = http.StatusUnauthorized
	case managedcredentialsservice.ErrGrantExpired, managedcredentialsservice.ErrGrantRevoked:
		status = http.StatusForbidden
	case managedcredentialsservice.ErrProviderNotConfigured,
		managedcredentialsservice.ErrModelPlanNotConfigured,
		managedcredentialsservice.ErrModelPlanSelectionRequired:
		status = http.StatusConflict
	}
	writeManagedCredentialError(w, status, err.Error())
}

func writeManagedCredentialError(w http.ResponseWriter, status int, message string) {
	tuttitypes.WriteError(w, status, "managed_credentials_error", strings.ReplaceAll(strings.ToLower(message), " ", "_"), message)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
