package managedcredentials

import "time"

type ProviderID string

const (
	ProviderAgnes     ProviderID = "agnes"
	ProviderOpenAI    ProviderID = "openai"
	ProviderAnthropic ProviderID = "anthropic"
)

func IsProviderID(value string) bool {
	switch ProviderID(value) {
	case ProviderAgnes, ProviderOpenAI, ProviderAnthropic:
		return true
	default:
		return false
	}
}

type Model struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Provider      ProviderID `json:"provider"`
	ModelPlanID   string     `json:"modelPlanId,omitempty"`
	ModelPlanName string     `json:"modelPlanName,omitempty"`
}

type ProviderConfig struct {
	WorkspaceID string     `json:"workspaceId"`
	Provider    ProviderID `json:"provider"`
	Enabled     bool       `json:"enabled"`
	APIKey      string     `json:"-"`
	BaseURL     string     `json:"baseUrl,omitempty"`
	Models      []Model    `json:"models"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

type PublicProviderConfig struct {
	WorkspaceID string     `json:"workspaceId"`
	Provider    ProviderID `json:"provider"`
	Enabled     bool       `json:"enabled"`
	APIKey      string     `json:"apiKey,omitempty"`
	HasAPIKey   bool       `json:"hasApiKey"`
	BaseURL     string     `json:"baseUrl,omitempty"`
	Models      []Model    `json:"models"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

func PublicProvider(config ProviderConfig) PublicProviderConfig {
	return PublicProviderConfig{
		WorkspaceID: config.WorkspaceID,
		Provider:    config.Provider,
		Enabled:     config.Enabled,
		HasAPIKey:   config.APIKey != "",
		BaseURL:     config.BaseURL,
		Models:      cloneModels(config.Models),
		UpdatedAt:   config.UpdatedAt,
	}
}

func cloneModels(models []Model) []Model {
	if len(models) == 0 {
		return []Model{}
	}
	return append([]Model(nil), models...)
}

type Grant struct {
	WorkspaceID  string
	AppID        string
	GrantRef     string
	ProviderIDs  []ProviderID
	ModelPlanIDs []string
	Scopes       []string
	CreatedAt    time.Time
	ExpiresAt    time.Time
	RevokedAt    *time.Time
}

type ProviderCredential struct {
	Provider      ProviderID `json:"provider"`
	APIKey        string     `json:"apiKey"`
	BaseURL       string     `json:"baseUrl,omitempty"`
	ModelPlanID   string     `json:"modelPlanId,omitempty"`
	ModelPlanName string     `json:"modelPlanName,omitempty"`
	Models        []Model    `json:"models,omitempty"`
}
