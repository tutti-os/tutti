package agentextension

import "time"

type Installation struct {
	SchemaVersion string    `json:"schemaVersion"`
	ID            string    `json:"id"`
	AgentKey      string    `json:"agentKey"`
	Version       string    `json:"version"`
	Provider      string    `json:"provider"`
	PackageDir    string    `json:"packageDir"`
	Manifest      Manifest  `json:"manifest"`
	InstalledAt   time.Time `json:"installedAt"`
	DisplayName   string    `json:"displayName"`
	AuthMessage   string    `json:"authMessage"`
}

type Manifest struct {
	SchemaVersion    string `json:"schemaVersion"`
	AgentKey         string `json:"agentKey"`
	Version          string `json:"version"`
	Name             string `json:"name"`
	Description      string `json:"description,omitempty"`
	LocalizationInfo struct {
		DefaultLocale     string `json:"defaultLocale"`
		DefaultFile       string `json:"defaultFile"`
		AdditionalLocales []struct {
			Locale string `json:"locale"`
			File   string `json:"file"`
		} `json:"additionalLocales,omitempty"`
	} `json:"localizationInfo"`
	Icon struct {
		Type string `json:"type"`
		Src  string `json:"src"`
	} `json:"icon"`
	HeroImage struct {
		Type string `json:"type"`
		Src  string `json:"src"`
	} `json:"heroImage,omitempty"`
	Runtime struct {
		Kind    string `json:"kind"`
		Install struct {
			Runner string   `json:"runner"`
			Args   []string `json:"args"`
		} `json:"install"`
		Launch struct {
			Executable string   `json:"executable"`
			Args       []string `json:"args"`
		} `json:"launch"`
	} `json:"runtime"`
	Profiles struct {
		Discovery    string `json:"discovery"`
		Tools        string `json:"tools,omitempty"`
		Capabilities string `json:"capabilities,omitempty"`
		Composer     string `json:"composer,omitempty"`
		Events       string `json:"events,omitempty"`
	} `json:"profiles"`
}
