package modelplan

import (
	"context"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	reporterevents "github.com/tutti-os/tutti/services/tuttid/service/reporter/events"
)

const (
	modelPlanConfigurationChangedEvent = "model_plan.configuration_changed"
	modelPlanDetectionCompletedEvent   = "model_plan.detection_completed"
)

func (s *Service) reportConfigurationChanged(
	ctx context.Context,
	action string,
	plan modelplanbiz.Plan,
) {
	if s == nil || s.AnalyticsReporter == nil {
		return
	}
	switch action {
	case "created", "updated", "duplicated", "enabled", "disabled", "deleted":
	default:
		return
	}
	reporterevents.Track(ctx, s.AnalyticsReporter, modelPlanConfigurationChangedEvent, map[string]any{
		"action":        action,
		"protocol":      normalizedAnalyticsProtocol(plan.Protocol),
		"template_kind": normalizedAnalyticsTemplateKind(plan.TemplateKind),
	})
}

func (s *Service) reportDetectionCompleted(
	ctx context.Context,
	scope string,
	protocol modelplanbiz.Protocol,
	templateKind modelplanbiz.TemplateKind,
	snapshot modelplanbiz.DetectionSnapshot,
) {
	if s == nil || s.AnalyticsReporter == nil {
		return
	}
	if scope != "draft" && scope != "saved" {
		scope = "unknown"
	}
	params := map[string]any{
		"protocol":      normalizedAnalyticsProtocol(protocol),
		"result":        "passed",
		"scope":         scope,
		"template_kind": normalizedAnalyticsTemplateKind(templateKind),
	}
	if !snapshot.CorePassed() {
		params["result"] = "failed"
		failureStage, failureReason := detectionFailure(snapshot)
		params["failure_stage"] = failureStage
		params["failure_reason"] = failureReason
	}
	reporterevents.Track(ctx, s.AnalyticsReporter, modelPlanDetectionCompletedEvent, params)
}

func detectionFailure(snapshot modelplanbiz.DetectionSnapshot) (string, string) {
	for _, stage := range modelplanbiz.DetectionStages() {
		result, ok := snapshot.StageOutcome(stage)
		if ok && result.Status == modelplanbiz.StageFailed {
			return string(stage), normalizedDetectionFailureReason(result.FailureReason)
		}
	}
	return "unknown", "unknown"
}

func normalizedAnalyticsProtocol(protocol modelplanbiz.Protocol) string {
	if modelplanbiz.IsProtocol(string(protocol)) {
		return string(protocol)
	}
	return "unknown"
}

func normalizedAnalyticsTemplateKind(kind modelplanbiz.TemplateKind) string {
	if modelplanbiz.IsTemplateKind(string(kind)) {
		return string(kind)
	}
	return "unknown"
}

func normalizedDetectionFailureReason(reason string) string {
	switch reason {
	case FailureConnection,
		FailureUnauthorized,
		FailureCatalogNotFound,
		FailureCatalogDecode,
		FailureNoModel,
		FailureModelRejected,
		FailureInference,
		FailureProviderRuntime,
		FailureProviderAuth:
		return reason
	default:
		return "unknown"
	}
}
