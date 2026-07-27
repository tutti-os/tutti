package modelplan

import (
	"context"
	"testing"
	"time"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

type recordingNativeSubscriptionProbe struct {
	input  NativeSubscriptionProbeInput
	result NativeSubscriptionProbeResult
}

func (p *recordingNativeSubscriptionProbe) ProbeNativeSubscription(
	_ context.Context,
	input NativeSubscriptionProbeInput,
) (NativeSubscriptionProbeResult, error) {
	p.input = input
	return p.result, nil
}

func TestDetectOfficialSubscriptionUsesProviderNativeProbe(t *testing.T) {
	probe := &recordingNativeSubscriptionProbe{result: NativeSubscriptionProbeResult{
		RuntimeAvailable:   true,
		Authenticated:      true,
		DiscoveredModels:   []modelplanbiz.Model{{ID: "gpt-native", Name: "GPT Native"}},
		InferenceAttempted: true,
		InferencePassed:    true,
		InferenceModel:     "gpt-native",
	}}
	service := &Service{
		NativeSubscriptionProbe: probe,
		Now: func() time.Time {
			return time.Date(2026, time.July, 23, 0, 0, 0, 0, time.UTC)
		},
	}

	result, err := service.Detect(context.Background(), DetectInput{
		WorkspaceID:  "workspace-1",
		TemplateKind: string(modelplanbiz.TemplateOfficialSubscription),
		Protocol:     string(modelplanbiz.ProtocolOpenAI),
	})
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if probe.input.WorkspaceID != "workspace-1" || probe.input.Protocol != modelplanbiz.ProtocolOpenAI {
		t.Fatalf("probe input = %#v", probe.input)
	}
	if len(result.DiscoveredModels) != 1 || result.DiscoveredModels[0].ID != "gpt-native" {
		t.Fatalf("discovered models = %#v", result.DiscoveredModels)
	}
	for _, stage := range []modelplanbiz.DetectionStage{
		modelplanbiz.StageNetwork,
		modelplanbiz.StageAuth,
		modelplanbiz.StageModelDiscovery,
		modelplanbiz.StageInference,
	} {
		outcome, ok := result.Detection.StageOutcome(stage)
		if !ok || outcome.Status != modelplanbiz.StagePassed {
			t.Fatalf("stage %q = %#v, %v", stage, outcome, ok)
		}
	}
}
