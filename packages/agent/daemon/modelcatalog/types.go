// Package modelcatalog owns provider-neutral model capability descriptors and
// provider protocol parsers. Process launch and caching remain host adapters.
package modelcatalog

type ReasoningEffortOption struct {
	Default     bool
	Description string
	Label       string
	Value       string
}

type SpeedOption struct {
	Description string
	Label       string
	Value       string
}

type ModelOption struct {
	ID                         string
	DisplayName                string
	Description                string
	DefaultReasoningEffort     string
	DefaultSpeed               string
	IsDefault                  bool
	ReasoningEffortsAdvertised bool
	SupportedReasoningEfforts  []ReasoningEffortOption
	SpeedsAdvertised           bool
	SupportedSpeeds            []SpeedOption
	SupportsImageInput         *bool
}

// ModelSelection is the capability projection for the effective model. Field
// presence is preserved so callers can distinguish an explicitly empty
// provider catalog from a provider that did not advertise that capability.
type ModelSelection struct {
	Model                      ModelOption
	Found                      bool
	ReasoningEffortsAdvertised bool
	ReasoningEfforts           []ReasoningEffortOption
	DefaultReasoningEffort     string
	SpeedsAdvertised           bool
	Speeds                     []SpeedOption
	DefaultSpeed               string
}
