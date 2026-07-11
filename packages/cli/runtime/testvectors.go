package runtime

import (
	"encoding/json"
	"fmt"
)

type ArgvVectorCorpus struct {
	Version       string           `json:"version"`
	InvokeContext InvokeContext    `json:"invokeContext"`
	Cases         []ArgvVectorCase `json:"cases"`
}

type ArgvVectorCase struct {
	Name               string         `json:"name"`
	CapabilityID       string         `json:"capabilityId"`
	Args               []string       `json:"args"`
	ExpectedInput      map[string]any `json:"expectedInput,omitempty"`
	ExpectedOutputMode string         `json:"expectedOutputMode,omitempty"`
	CatalogError       string         `json:"catalogError,omitempty"`
	InvokeError        string         `json:"invokeError,omitempty"`
	ExpectedInvoke     bool           `json:"expectedInvoke"`
	ExpectedStdout     string         `json:"expectedStdout"`
	ExpectedStderr     string         `json:"expectedStderr"`
	ExpectedExit       int            `json:"expectedExit"`
}

type RenderVectorCorpus struct {
	Version string             `json:"version"`
	Cases   []RenderVectorCase `json:"cases"`
}

type RenderVectorCase struct {
	Name           string        `json:"name"`
	JSON           bool          `json:"json,omitempty"`
	Output         CommandOutput `json:"output"`
	ExpectedStdout string        `json:"expectedStdout"`
	ExpectedStderr string        `json:"expectedStderr"`
	ExpectedExit   int           `json:"expectedExit"`
}

type GateVectorCorpus struct {
	Version   string         `json:"version"`
	Snapshots []GateSnapshot `json:"snapshots"`
}

type HTTPVectorCorpus struct {
	Version                string                    `json:"version"`
	CapabilityRequests     []CapabilityRequestVector `json:"capabilityRequests"`
	InvokePaths            []InvokePathVector        `json:"invokePaths"`
	InvokeRequestJSON      string                    `json:"invokeRequestJson"`
	CapabilityResponseJSON string                    `json:"capabilityResponseJson"`
	InvokeResponseJSON     string                    `json:"invokeResponseJson"`
}

type CapabilityRequestVector struct {
	Name               string `json:"name"`
	WorkspaceID        string `json:"workspaceID,omitempty"`
	IncludeHidden      bool   `json:"includeHidden,omitempty"`
	IncludeIntegration bool   `json:"includeIntegration,omitempty"`
	ExpectedPath       string `json:"expectedPath"`
}

type InvokePathVector struct {
	Name         string `json:"name"`
	CommandID    string `json:"commandID"`
	ExpectedPath string `json:"expectedPath"`
}

type ManifestVectorCorpus struct {
	Version                string         `json:"version"`
	ExpectedCommandCount   int            `json:"expectedCommandCount"`
	RegistrationGateCounts map[string]int `json:"registrationGateCounts"`
	AllowedVisibility      []string       `json:"allowedVisibility"`
	AllowedSourceKinds     []string       `json:"allowedSourceKinds"`
}

type GateSnapshot struct {
	Name                 string          `json:"name"`
	RegistrationGates    map[string]bool `json:"registrationGates"`
	ProviderAvailability map[string]bool `json:"providerAvailability"`
	RequestContext       map[string]bool `json:"requestContext"`
	IncludeIntegration   bool            `json:"includeIntegration"`
	ExpectedCommandCount int             `json:"expectedCommandCount"`
}

type DomainScenarioCorpus struct {
	Version            string           `json:"version"`
	NormalizationRules []string         `json:"normalizationRules"`
	Scenarios          []DomainScenario `json:"scenarios"`
}

type DomainScenario struct {
	ID             string                `json:"id"`
	CommandID      string                `json:"commandId"`
	Normalizers    []string              `json:"normalizers,omitempty"`
	Postconditions []DomainPostcondition `json:"postconditions"`
}

type DomainPostcondition struct {
	Key      string `json:"key"`
	Expected any    `json:"expected"`
}

func LoadArgvVectors() (ArgvVectorCorpus, error) {
	var corpus ArgvVectorCorpus
	return corpus, loadCorpus("testvectors/argv.json", &corpus, func() string { return corpus.Version })
}

func LoadRenderVectors() (RenderVectorCorpus, error) {
	var corpus RenderVectorCorpus
	return corpus, loadCorpus("testvectors/render.json", &corpus, func() string { return corpus.Version })
}

func LoadGateVectors() (GateVectorCorpus, error) {
	var corpus GateVectorCorpus
	return corpus, loadCorpus("testvectors/gates.json", &corpus, func() string { return corpus.Version })
}

func LoadHTTPVectors() (HTTPVectorCorpus, error) {
	var corpus HTTPVectorCorpus
	return corpus, loadCorpus("testvectors/http.json", &corpus, func() string { return corpus.Version })
}

func LoadManifestVectors() (ManifestVectorCorpus, error) {
	var corpus ManifestVectorCorpus
	return corpus, loadCorpus("testvectors/manifest.json", &corpus, func() string { return corpus.Version })
}

func LoadDomainScenarios() (DomainScenarioCorpus, error) {
	var corpus DomainScenarioCorpus
	return corpus, loadCorpus("testvectors/domain_scenarios.json", &corpus, func() string { return corpus.Version })
}

func loadCorpus(path string, target any, version func() string) error {
	content, err := assets.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read embedded corpus %s: %w", path, err)
	}
	if err := json.Unmarshal(content, target); err != nil {
		return fmt.Errorf("decode embedded corpus %s: %w", path, err)
	}
	if version() != CorpusVersion {
		return fmt.Errorf("unsupported corpus version %q in %s", version(), path)
	}
	return nil
}
