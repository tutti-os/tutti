package agentextension

import "time"

type Installation struct {
	SchemaVersion            string    `json:"schemaVersion"`
	ID                       string    `json:"id"`
	AgentKey                 string    `json:"agentKey"`
	Version                  string    `json:"version"`
	Provider                 string    `json:"provider"`
	PackageDir               string    `json:"packageDir"`
	PackageContentSHA256     string    `json:"packageContentSha256"`
	ReleaseArtifactSHA256    string    `json:"releaseArtifactSha256,omitempty"`
	ReleaseArtifactSizeBytes int64     `json:"releaseArtifactSizeBytes,omitempty"`
	Manifest                 Manifest  `json:"manifest"`
	InstalledAt              time.Time `json:"installedAt"`
	DisplayName              string    `json:"displayName"`
	AuthMessage              string    `json:"authMessage"`
}

type RuntimeBinaryArtifact struct {
	Kind       string `json:"kind"`
	Platform   string `json:"platform"`
	Version    string `json:"version"`
	URL        string `json:"url"`
	SHA256     string `json:"sha256"`
	SizeBytes  int64  `json:"sizeBytes"`
	Provenance struct {
		Kind string `json:"kind"`
		URL  string `json:"url"`
	} `json:"provenance"`
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
	MaskIcon struct {
		Type string `json:"type"`
		Src  string `json:"src"`
	} `json:"maskIcon,omitempty"`
	HeroImage struct {
		Type string `json:"type"`
		Src  string `json:"src"`
	} `json:"heroImage,omitempty"`
	Runtime struct {
		Kind    string `json:"kind"`
		Install struct {
			Runner    string                  `json:"runner"`
			Args      []string                `json:"args,omitempty"`
			Artifacts []RuntimeBinaryArtifact `json:"artifacts,omitempty"`
		} `json:"install"`
		Launch struct {
			Executable         string   `json:"executable"`
			Args               []string `json:"args"`
			PublishUserCommand *bool    `json:"publishUserCommand,omitempty"`
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
