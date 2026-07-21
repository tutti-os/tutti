package agentruntime

// Hermes now ships as an Agent Extension. These values keep the generic ACP
// adapter regression suite representative without reintroducing a production
// provider descriptor or constructor.
const hermesExtensionTestProvider = "acp:hermes"

func newHermesExtensionTestAdapter(transport ProcessTransport) *standardACPAdapter {
	adapter, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:                 hermesExtensionTestProvider,
		Name:                     "hermes-acp",
		DisplayName:              "Hermes Agent",
		Command:                  []string{"hermes", "acp"},
		ModelConfigOptionID:      "model",
		PermissionConfigOptionID: "mode",
		ReasoningConfigOptionID:  "effort",
		PermissionModes: map[string]string{
			"":            "dont_ask",
			"auto":        "dont_ask",
			"full-access": "dont_ask",
			"read-only":   "dont_ask",
			"yolo":        "dont_ask",
		},
		AutomaticPermissionDecisions: map[string]string{"yolo": "approved"},
		Capabilities:                 []string{CapabilityInterrupt},
	}, transport, LegacyHostMetadata())
	if err != nil {
		panic(err)
	}
	return adapter.(*standardACPAdapter)
}
