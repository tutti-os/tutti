package api

import (
	"context"
	"errors"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
)

type AgentTargetAccountUsageService interface {
	Probe(context.Context, string) (agentextensionservice.AccountUsageResult, error)
}

func (api DaemonAPI) ProbeAgentTargetAccountUsage(
	ctx context.Context,
	request tuttigenerated.ProbeAgentTargetAccountUsageRequestObject,
) (tuttigenerated.ProbeAgentTargetAccountUsageResponseObject, error) {
	if api.AgentTargetAccountUsage == nil {
		return tuttigenerated.ProbeAgentTargetAccountUsage503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(
					"agent_target_account_usage_unavailable",
					apierrors.WithDeveloperMessage("agent target account usage service is unavailable"),
				),
			),
		}, nil
	}
	if strings.TrimSpace(request.AgentTargetID) == "" {
		return invalidAgentTargetAccountUsageRequest(), nil
	}
	result, err := api.AgentTargetAccountUsage.Probe(ctx, request.AgentTargetID)
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrAgentTargetNotFound):
			return tuttigenerated.ProbeAgentTargetAccountUsage404JSONResponse{
				AgentTargetNotFoundErrorJSONResponse: agentTargetNotFoundError(),
			}, nil
		case errors.Is(err, agentextensionservice.ErrInvalidAccountUsageTarget):
			return invalidAgentTargetAccountUsageRequest(), nil
		default:
			return tuttigenerated.ProbeAgentTargetAccountUsage503JSONResponse{
				ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
					apierrors.ServiceUnavailable(
						"agent_target_account_usage_unavailable",
						apierrors.WithCause(err),
					),
				),
			}, nil
		}
	}
	projected, err := projectAgentTargetAccountUsage(result)
	if err != nil {
		return tuttigenerated.ProbeAgentTargetAccountUsage503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(
					"agent_target_account_usage_projection_failed",
					apierrors.WithCause(err),
				),
			),
		}, nil
	}
	return tuttigenerated.ProbeAgentTargetAccountUsage200JSONResponse(projected), nil
}

func projectAgentTargetAccountUsage(
	result agentextensionservice.AccountUsageResult,
) (tuttigenerated.AgentTargetAccountUsageProbeResult, error) {
	var projected tuttigenerated.AgentTargetAccountUsageProbeResult
	switch result.Outcome {
	case "available":
		quotas := make([]tuttigenerated.AgentTargetAccountUsageQuota, 0, len(result.Quotas))
		for _, quota := range result.Quotas {
			value := tuttigenerated.AgentTargetAccountUsageQuota{
				QuotaType:        tuttigenerated.AgentTargetAccountUsageQuotaType(quota.QuotaType),
				PercentRemaining: float32(quota.PercentRemaining),
				ResetsAtUnixMs:   quota.ResetsAtUnixMS,
			}
			if quota.ModelName != "" {
				modelName := quota.ModelName
				value.ModelName = &modelName
			}
			quotas = append(quotas, value)
		}
		err := projected.FromAgentTargetAccountUsageAvailableResult(
			tuttigenerated.AgentTargetAccountUsageAvailableResult{
				SchemaVersion: tuttigenerated.AgentTargetAccountUsageAvailableResultSchemaVersionTuttiAgentAccountUsageV1,
				AgentTargetId: result.AgentTargetID, Provider: tuttigenerated.AgentTargetProvider(result.Provider),
				Outcome:          tuttigenerated.AgentTargetAccountUsageAvailableResultOutcomeAvailable,
				CapturedAtUnixMs: result.CapturedAtUnixMS,
				BillingMode:      tuttigenerated.AgentTargetAccountUsageBillingMode(result.BillingMode), Quotas: quotas,
			},
		)
		return projected, err
	case "unsupported":
		err := projected.FromAgentTargetAccountUsageUnsupportedResult(
			tuttigenerated.AgentTargetAccountUsageUnsupportedResult{
				SchemaVersion: tuttigenerated.TuttiAgentAccountUsageV1,
				AgentTargetId: result.AgentTargetID, Provider: tuttigenerated.AgentTargetProvider(result.Provider),
				Outcome: tuttigenerated.Unsupported, CapturedAtUnixMs: result.CapturedAtUnixMS,
			},
		)
		return projected, err
	case "error":
		err := projected.FromAgentTargetAccountUsageErrorResult(
			tuttigenerated.AgentTargetAccountUsageErrorResult{
				SchemaVersion: tuttigenerated.AgentTargetAccountUsageErrorResultSchemaVersionTuttiAgentAccountUsageV1,
				AgentTargetId: result.AgentTargetID, Provider: tuttigenerated.AgentTargetProvider(result.Provider),
				Outcome:          tuttigenerated.AgentTargetAccountUsageErrorResultOutcomeError,
				CapturedAtUnixMs: result.CapturedAtUnixMS,
				ErrorCode:        tuttigenerated.AgentTargetAccountUsageErrorCode(result.ErrorCode),
			},
		)
		return projected, err
	default:
		return projected, errors.New("account usage outcome is invalid")
	}
}

func invalidAgentTargetAccountUsageRequest() tuttigenerated.ProbeAgentTargetAccountUsage400JSONResponse {
	return tuttigenerated.ProbeAgentTargetAccountUsage400JSONResponse{
		InvalidRequestErrorJSONResponse: invalidRequestError(
			apierrors.InvalidRequest(
				"invalid_agent_target_account_usage_request",
				apierrors.WithDeveloperMessage("agent target id is required"),
			),
		),
	}
}
