package agenttarget

import (
	"encoding/json"
	"errors"
	"log/slog"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func GeneratedListAgentTargetsResponseFromBiz(targets []agenttargetbiz.Target) (tuttigenerated.ListAgentTargetsResponse, error) {
	result := make([]tuttigenerated.AgentTarget, 0, len(targets))
	for _, target := range targets {
		generated, err := GeneratedAgentTargetFromBiz(target)
		if err != nil {
			if isSkippableAgentTargetError(err) {
				slog.Warn("skipping invalid agent target in API response", "targetId", target.ID, "error", err)
				continue
			}
			return tuttigenerated.ListAgentTargetsResponse{}, err
		}
		result = append(result, generated)
	}
	return tuttigenerated.ListAgentTargetsResponse{Targets: result}, nil
}

func GeneratedAgentTargetFromBiz(target agenttargetbiz.Target) (tuttigenerated.AgentTarget, error) {
	normalized, err := agenttargetbiz.NormalizeTarget(target)
	if err != nil {
		return tuttigenerated.AgentTarget{}, err
	}
	var ref agenttargetbiz.LaunchRef
	if err := json.Unmarshal([]byte(normalized.LaunchRefJSON), &ref); err != nil {
		return tuttigenerated.AgentTarget{}, err
	}
	iconKey := &normalized.IconKey
	if normalized.IconKey == "" {
		iconKey = nil
	}
	return tuttigenerated.AgentTarget{
		CreatedAtUnixMs: normalized.CreatedAtUnixMS,
		Enabled:         normalized.Enabled,
		IconKey:         iconKey,
		Id:              normalized.ID,
		LaunchRef: tuttigenerated.AgentTargetLaunchRef{
			Provider: tuttigenerated.AgentTargetProvider(ref.Provider),
			Type:     tuttigenerated.LocalCli,
		},
		Name:            normalized.Name,
		Provider:        tuttigenerated.AgentTargetProvider(normalized.Provider),
		SortOrder:       normalized.SortOrder,
		Source:          tuttigenerated.AgentTargetSource(normalized.Source),
		UpdatedAtUnixMs: normalized.UpdatedAtUnixMS,
	}, nil
}

func isSkippableAgentTargetError(err error) bool {
	return errors.Is(err, agenttargetbiz.ErrInvalidTarget) ||
		errors.Is(err, agenttargetbiz.ErrInvalidLaunchRef)
}
