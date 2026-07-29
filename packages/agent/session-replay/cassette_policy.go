package sessionreplay

import (
	_ "embed"
	"encoding/json"
)

type CassettePolicy struct {
	SchemaVersion             int                           `json:"schemaVersion"`
	BlobManifestSchemaVersion int                           `json:"blobManifestSchemaVersion"`
	Limits                    CassettePolicyLimits          `json:"limits"`
	Files                     map[string]CassettePolicyFile `json:"files"`
}

type CassettePolicyLimits struct {
	MaxProviderPayloadBytes int64 `json:"maxProviderPayloadBytes"`
	MaxProviderTapeBytes    int64 `json:"maxProviderTapeBytes"`
	MaxCassetteBytes        int64 `json:"maxCassetteBytes"`
	MaxPortableBlobBytes    int64 `json:"maxPortableBlobBytes"`
}

type CassettePolicyFile struct {
	Path      string `json:"path"`
	Role      string `json:"role"`
	Required  bool   `json:"required"`
	Inventory *bool  `json:"inventory,omitempty"`
}

//go:embed cassette-policy.json
var cassettePolicyJSON []byte

var PortableCassettePolicy = mustCassettePolicy()

var (
	CassetteSchemaVersion     = PortableCassettePolicy.SchemaVersion
	BlobManifestSchemaVersion = PortableCassettePolicy.BlobManifestSchemaVersion
	MaxProviderPayloadBytes   = PortableCassettePolicy.Limits.MaxProviderPayloadBytes
	MaxProviderTapeBytes      = PortableCassettePolicy.Limits.MaxProviderTapeBytes
	MaxCassetteBytes          = PortableCassettePolicy.Limits.MaxCassetteBytes
	MaxPortableBlobBytes      = PortableCassettePolicy.Limits.MaxPortableBlobBytes

	ScenarioFile         = cassettePolicyPath("scenario")
	EnvironmentFile      = cassettePolicyPath("environment")
	ActivityEventsFile   = cassettePolicyPath("activityEvents")
	CheckpointsFile      = cassettePolicyPath("checkpoints")
	SeedFixtureFile      = cassettePolicyPath("seedFixture")
	ProviderManifestFile = cassettePolicyPath("providerManifest")
	ProviderFramesFile   = cassettePolicyPath("providerFrames")
	ExpectedFixtureFile  = cassettePolicyPath("expectedFixture")
	BlobManifestFile     = cassettePolicyPath("blobManifest")
	CassetteManifestFile = cassettePolicyPath("cassetteManifest")
)

func mustCassettePolicy() CassettePolicy {
	var policy CassettePolicy
	if err := json.Unmarshal(cassettePolicyJSON, &policy); err != nil {
		panic(err)
	}
	return policy
}

func cassettePolicyPath(name string) string {
	file, ok := PortableCassettePolicy.Files[name]
	if !ok || file.Path == "" {
		panic("cassette policy is missing file " + name)
	}
	return file.Path
}
