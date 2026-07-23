package modelplan

import (
	"context"
	"strings"
	"time"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

// NativeSubscriptionProbe verifies an official provider subscription through
// the provider's own Agent runtime and stored login. It never receives or
// returns provider credentials.
type NativeSubscriptionProbe interface {
	ProbeNativeSubscription(context.Context, NativeSubscriptionProbeInput) (NativeSubscriptionProbeResult, error)
}

type NativeSubscriptionProbeInput struct {
	WorkspaceID string
	Protocol    modelplanbiz.Protocol
	Model       string
	Models      []modelplanbiz.Model
}

type NativeSubscriptionProbeResult struct {
	RuntimeAvailable   bool
	RuntimeDetail      string
	RuntimeLatencyMs   int64
	Authenticated      bool
	AuthDetail         string
	DiscoveredModels   []modelplanbiz.Model
	DiscoveryDetail    string
	DiscoveryLatencyMs int64
	InferenceAttempted bool
	InferencePassed    bool
	InferenceModel     string
	InferenceDetail    string
	InferenceLatencyMs int64
}

func (s *Service) detectNativeSubscription(
	ctx context.Context,
	input NativeSubscriptionProbeInput,
	now time.Time,
) (modelplanbiz.DetectionSnapshot, []modelplanbiz.Model) {
	snapshot := modelplanbiz.DetectionSnapshot{CheckedAt: now, Model: strings.TrimSpace(input.Model)}
	if s.NativeSubscriptionProbe == nil {
		snapshot.Stages = nativeSubscriptionUnavailableStages(now, "native subscription probe is unavailable")
		return snapshot, nil
	}

	result, err := s.NativeSubscriptionProbe.ProbeNativeSubscription(ctx, input)
	if err != nil {
		snapshot.Stages = nativeSubscriptionUnavailableStages(now, sanitizeNativeProbeDetail(err.Error()))
		return snapshot, nil
	}
	if model := strings.TrimSpace(result.InferenceModel); model != "" {
		snapshot.Model = model
	}

	network := modelplanbiz.StageResult{
		Stage:     modelplanbiz.StageNetwork,
		Status:    modelplanbiz.StagePassed,
		LatencyMs: result.RuntimeLatencyMs,
		Detail:    sanitizeNativeProbeDetail(result.RuntimeDetail),
		CheckedAt: now,
	}
	if !result.RuntimeAvailable {
		network.Status = modelplanbiz.StageFailed
		network.FailureReason = FailureProviderRuntime
		network.Remedy = RemedyEnableProvider
	}

	auth := modelplanbiz.StageResult{
		Stage:     modelplanbiz.StageAuth,
		Status:    modelplanbiz.StageSkipped,
		Detail:    sanitizeNativeProbeDetail(result.AuthDetail),
		CheckedAt: now,
	}
	if result.RuntimeAvailable {
		auth.Status = modelplanbiz.StagePassed
		if !result.Authenticated {
			auth.Status = modelplanbiz.StageFailed
			auth.FailureReason = FailureProviderAuth
			auth.Remedy = RemedyLoginProvider
		}
	}

	discovered := modelplanbiz.NormalizeModels(result.DiscoveredModels)
	discovery := modelplanbiz.StageResult{
		Stage:     modelplanbiz.StageModelDiscovery,
		Status:    modelplanbiz.StageSkipped,
		LatencyMs: result.DiscoveryLatencyMs,
		Detail:    sanitizeNativeProbeDetail(result.DiscoveryDetail),
		CheckedAt: now,
	}
	if network.Status == modelplanbiz.StagePassed && auth.Status == modelplanbiz.StagePassed {
		switch {
		case len(discovered) > 0:
			discovery.Status = modelplanbiz.StagePassed
		case len(modelplanbiz.NormalizeModels(input.Models)) > 0:
			discovery.Status = modelplanbiz.StageSkipped
			if discovery.Detail == "" {
				discovery.Detail = "using configured model list"
			}
		default:
			discovery.Status = modelplanbiz.StageFailed
			discovery.FailureReason = FailureCatalogNotFound
			discovery.Remedy = RemedyAddModelsManually
		}
	}

	inference := modelplanbiz.StageResult{
		Stage:     modelplanbiz.StageInference,
		Status:    modelplanbiz.StageSkipped,
		LatencyMs: result.InferenceLatencyMs,
		Detail:    sanitizeNativeProbeDetail(result.InferenceDetail),
		CheckedAt: now,
	}
	if network.Status == modelplanbiz.StagePassed && auth.Status == modelplanbiz.StagePassed && discovery.Status != modelplanbiz.StageFailed {
		switch {
		case strings.TrimSpace(snapshot.Model) == "":
			inference.Status = modelplanbiz.StageFailed
			inference.FailureReason = FailureNoModel
			inference.Remedy = RemedySelectModel
		case !result.InferenceAttempted:
			inference.Status = modelplanbiz.StageFailed
			inference.FailureReason = FailureInference
			inference.Remedy = RemedyRetryInference
		case result.InferencePassed:
			inference.Status = modelplanbiz.StagePassed
		default:
			inference.Status = modelplanbiz.StageFailed
			inference.FailureReason = FailureInference
			inference.Remedy = RemedyRetryInference
		}
	}

	snapshot.Stages = []modelplanbiz.StageResult{network, auth, discovery, inference}
	return snapshot, discovered
}

func nativeSubscriptionUnavailableStages(now time.Time, detail string) []modelplanbiz.StageResult {
	return []modelplanbiz.StageResult{
		{Stage: modelplanbiz.StageNetwork, Status: modelplanbiz.StageFailed, FailureReason: FailureProviderRuntime, Remedy: RemedyEnableProvider, Detail: detail, CheckedAt: now},
		{Stage: modelplanbiz.StageAuth, Status: modelplanbiz.StageSkipped, CheckedAt: now},
		{Stage: modelplanbiz.StageModelDiscovery, Status: modelplanbiz.StageSkipped, CheckedAt: now},
		{Stage: modelplanbiz.StageInference, Status: modelplanbiz.StageSkipped, CheckedAt: now},
	}
}

func sanitizeNativeProbeDetail(detail string) string {
	detail = strings.TrimSpace(detail)
	const maxDetailBytes = 500
	if len(detail) > maxDetailBytes {
		return detail[:maxDetailBytes]
	}
	return detail
}
