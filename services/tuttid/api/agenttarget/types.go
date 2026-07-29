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
	iconURL := &normalized.IconURL
	if normalized.IconURL == "" {
		iconURL = nil
	}
	maskIconURL := &normalized.MaskIconURL
	if normalized.MaskIconURL == "" {
		maskIconURL = nil
	}
	heroImageURL := &normalized.HeroImageURL
	if normalized.HeroImageURL == "" {
		heroImageURL = nil
	}
	var availability *tuttigenerated.AgentProviderAvailability
	if normalized.AvailabilityStatus != "" {
		availability = &tuttigenerated.AgentProviderAvailability{
			Status: tuttigenerated.AgentProviderAvailabilityStatus(normalized.AvailabilityStatus),
		}
		if normalized.AvailabilityReason != "" {
			availability.ReasonCode = &normalized.AvailabilityReason
		}
	}
	var launchRef tuttigenerated.AgentTargetLaunchRef
	switch ref.Type {
	case agenttargetbiz.LaunchRefTypeBuiltinLocal:
		if err := launchRef.FromAgentTargetBuiltinLocalLaunchRef(tuttigenerated.AgentTargetBuiltinLocalLaunchRef{
			Provider: ref.Provider,
			Type:     tuttigenerated.AgentTargetBuiltinLocalLaunchRefTypeBuiltinLocal,
		}); err != nil {
			return tuttigenerated.AgentTarget{}, err
		}
	case agenttargetbiz.LaunchRefTypeAgentExtension:
		if err := launchRef.FromAgentTargetExtensionLaunchRef(tuttigenerated.AgentTargetExtensionLaunchRef{
			ExtensionInstallationId: ref.ExtensionInstallationID,
			Type:                    tuttigenerated.AgentTargetExtensionLaunchRefTypeAgentExtension,
		}); err != nil {
			return tuttigenerated.AgentTarget{}, err
		}
	default:
		return tuttigenerated.AgentTarget{}, agenttargetbiz.ErrInvalidLaunchRef
	}
	return tuttigenerated.AgentTarget{
		Availability:    availability,
		CreatedAtUnixMs: normalized.CreatedAtUnixMS,
		Enabled:         normalized.Enabled,
		IconKey:         iconKey,
		IconUrl:         iconURL,
		MaskIconUrl:     maskIconURL,
		HeroImageUrl:    heroImageURL,
		Id:              normalized.ID,
		LaunchRef:       launchRef,
		Name:            normalized.Name,
		Provider:        normalized.Provider,
		SortOrder:       normalized.SortOrder,
		Source:          tuttigenerated.AgentTargetSource(normalized.Source),
		UpdatedAtUnixMs: normalized.UpdatedAtUnixMS,
	}, nil
}

func isSkippableAgentTargetError(err error) bool {
	return errors.Is(err, agenttargetbiz.ErrInvalidTarget) ||
		errors.Is(err, agenttargetbiz.ErrInvalidLaunchRef)
}
