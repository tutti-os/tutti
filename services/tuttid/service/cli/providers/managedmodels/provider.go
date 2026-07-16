package managedmodels

import (
	"context"
	"fmt"
	"strings"
	"time"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	managedcredentialsservice "github.com/tutti-os/tutti/services/tuttid/service/managedcredentials"
)

const providerID = "managed-model"

const (
	commandGrantExchange = providerID + ".grant.exchange"
	commandModels        = providerID + ".models"
	commandCredential    = providerID + ".credential"
	commandRevoke        = providerID + ".revoke"
)

type Provider struct {
	service *managedcredentialsservice.Service
}

func NewProvider(service *managedcredentialsservice.Service) Provider {
	return Provider{service: service}
}

func (Provider) AppID() string {
	return providerID
}

func (p Provider) Commands() []cliservice.Command {
	return []cliservice.Command{
		p.newExchangeCommand(),
		p.newModelsCommand(),
		p.newCredentialCommand(),
		p.newRevokeCommand(),
	}
}

func (p Provider) newExchangeCommand() cliservice.Command {
	return p.command(commandGrantExchange, []string{"managed-model", "grant", "exchange"}, "Exchange a managed-model grant", []string{"contextToken", "grantCode", "nonce", "state"}, nil, p.exchange)
}

func (p Provider) newModelsCommand() cliservice.Command {
	return p.command(commandModels, []string{"managed-model", "models"}, "List managed-model grant models", []string{"grantRef"}, nil, p.models)
}

func (p Provider) newCredentialCommand() cliservice.Command {
	return p.command(commandCredential, []string{"managed-model", "credential"}, "Lease a managed-model provider credential", []string{"grantRef", "provider", "model", "capability"}, []string{"modelPlanId"}, p.credential)
}

func (p Provider) newRevokeCommand() cliservice.Command {
	return p.command(commandRevoke, []string{"managed-model", "revoke"}, "Revoke a managed-model grant", []string{"grantRef"}, nil, p.revoke)
}

func (p Provider) command(id string, path []string, summary string, required []string, optional []string, run func(context.Context, cliservice.InvokeRequest) (map[string]any, error)) cliservice.Command {
	properties := map[string]any{}
	for _, name := range append(append([]string(nil), required...), optional...) {
		properties[name] = map[string]any{"type": "string"}
	}
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          id,
			Path:        path,
			Summary:     summary,
			Description: summary + ". This integration command is available only from a workspace app CLI context.",
			Visibility:  cliservice.CapabilityVisibilityIntegration,
			InputSchema: map[string]any{"type": "object", "required": required, "properties": properties},
			Output: cliservice.CapabilityOutput{
				DefaultMode: cliservice.OutputModeJSON,
				JSON:        true,
			},
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			if p.service == nil {
				return cliservice.CommandOutput{}, cliservice.ServiceUnavailableError("managed_model_service_unavailable", fmt.Errorf("managed model service is unavailable"))
			}
			if err := requireExactInput(request.Input, required, optional); err != nil {
				return cliservice.CommandOutput{}, err
			}
			if err := requireAppContext(request.Context); err != nil {
				return cliservice.CommandOutput{}, err
			}
			value, err := run(ctx, request)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return cliservice.CommandOutput{Kind: cliservice.OutputModeJSON, Value: value}, nil
		},
	}
}

func (p Provider) exchange(ctx context.Context, request cliservice.InvokeRequest) (map[string]any, error) {
	result, err := p.service.Exchange(ctx, managedcredentialsservice.ExchangeInput{
		AppID:        request.Context.AppID,
		ContextToken: request.Input["contextToken"].(string),
		GrantCode:    request.Input["grantCode"].(string),
		Nonce:        request.Input["nonce"].(string),
		State:        request.Input["state"].(string),
		WorkspaceID:  request.Context.WorkspaceID,
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"expiresAt":    formatTime(result.ExpiresAt),
		"grantRef":     result.GrantRef,
		"modelPlanIds": result.ModelPlanIDs,
		"models":       result.Models,
		"providers":    result.Providers,
	}, nil
}

func (p Provider) models(ctx context.Context, request cliservice.InvokeRequest) (map[string]any, error) {
	result, err := p.service.ListGrantModels(ctx, request.Context.WorkspaceID, request.Context.AppID, request.Input["grantRef"].(string))
	if err != nil {
		return nil, err
	}
	return map[string]any{"expiresAt": formatTime(result.ExpiresAt), "models": result.Models}, nil
}

func (p Provider) credential(ctx context.Context, request cliservice.InvokeRequest) (map[string]any, error) {
	result, err := p.service.Credential(ctx, managedcredentialsservice.CredentialInput{
		AppID:       request.Context.AppID,
		Capability:  request.Input["capability"].(string),
		GrantRef:    request.Input["grantRef"].(string),
		Model:       request.Input["model"].(string),
		ModelPlanID: optionalString(request.Input, "modelPlanId"),
		Provider:    request.Input["provider"].(string),
		WorkspaceID: request.Context.WorkspaceID,
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"credential": result.Credential,
		"expiresAt":  formatTime(result.ExpiresAt),
		"models":     result.GrantModels,
	}, nil
}

func (p Provider) revoke(ctx context.Context, request cliservice.InvokeRequest) (map[string]any, error) {
	if err := p.service.Revoke(ctx, request.Context.WorkspaceID, request.Context.AppID, request.Input["grantRef"].(string)); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func requireAppContext(context cliservice.InvokeContext) error {
	if strings.TrimSpace(context.WorkspaceID) == "" || strings.TrimSpace(context.AppID) == "" {
		return fmt.Errorf("%w: managed-model commands require workspace and app context", cliservice.ErrInvalidInput)
	}
	return nil
}

func requireExactInput(input map[string]any, required []string, optional []string) error {
	if input == nil {
		return fmt.Errorf("%w: command input is required", cliservice.ErrInvalidInput)
	}
	allowed := make(map[string]struct{}, len(required))
	for _, name := range required {
		allowed[name] = struct{}{}
		value, ok := input[name].(string)
		if !ok || strings.TrimSpace(value) == "" {
			return fmt.Errorf("%w: %s is required", cliservice.ErrInvalidInput, name)
		}
	}
	for _, name := range optional {
		allowed[name] = struct{}{}
		if value, ok := input[name]; ok {
			text, valid := value.(string)
			if !valid || strings.TrimSpace(text) == "" {
				return fmt.Errorf("%w: %s must be a non-empty string when provided", cliservice.ErrInvalidInput, name)
			}
		}
	}
	for name := range input {
		if _, ok := allowed[name]; !ok {
			return fmt.Errorf("%w: %s is not supported", cliservice.ErrInvalidInput, name)
		}
	}
	return nil
}

func optionalString(input map[string]any, key string) string {
	value, _ := input[key].(string)
	return strings.TrimSpace(value)
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339)
}
