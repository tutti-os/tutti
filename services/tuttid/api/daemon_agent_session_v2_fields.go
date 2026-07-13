package api

import (
	"encoding/json"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func generatedAgentSessionCapabilities(raw []string) *tuttigenerated.WorkspaceAgentCapabilities {
	capabilities := generatedAgentCapabilities(raw)
	return &capabilities
}

func generatedAgentCapabilities(raw []string) tuttigenerated.WorkspaceAgentCapabilities {
	capabilities := tuttigenerated.WorkspaceAgentCapabilities{}
	for _, capability := range raw {
		switch strings.TrimSpace(capability) {
		case "browserUse":
			capabilities.BrowserUse = true
		case "compact":
			capabilities.Compact = true
		case "computerUse":
			capabilities.ComputerUse = true
		case "goalPause":
			capabilities.GoalPause = true
		case "imageInput":
			capabilities.ImageInput = true
		case "modelImageInputRequired":
			capabilities.ModelImageInputRequired = true
		case "interrupt":
			capabilities.Interrupt = true
		case "permissionModeChangeDeferred":
			capabilities.PermissionModeChangeDeferred = true
		case "permissionModeChangeDuringTurn":
			capabilities.PermissionModeChangeDuringTurn = true
		case "planImplementation":
			capabilities.PlanImplementation = true
		case "planMode":
			capabilities.PlanMode = true
		case "rateLimits":
			capabilities.RateLimits = true
		case "resumeRunningTurn":
			capabilities.ResumeRunningTurn = true
		case "review":
			capabilities.Review = true
		case "skills":
			capabilities.Skills = true
		case "tokenUsage":
			capabilities.TokenUsage = true
		}
	}
	return capabilities
}

func generatedAgentSessionUsage(raw *agentactivitybiz.SessionUsage) *tuttigenerated.WorkspaceAgentUsage {
	var result tuttigenerated.WorkspaceAgentUsage
	if !decodeTypedAgentSessionField(raw, &result) {
		return nil
	}
	if result.ContextWindow == nil && len(result.Quotas) == 0 {
		return nil
	}
	if result.ContextWindow != nil && (result.ContextWindow.UsedTokens < 0 || result.ContextWindow.TotalTokens <= 0) {
		return nil
	}
	if result.Quotas == nil {
		result.Quotas = []tuttigenerated.WorkspaceAgentUsageQuota{}
	}
	return &result
}

func generatedAgentSessionBackgroundAgents(raw *agentactivitybiz.SessionBackgroundAgents) *tuttigenerated.WorkspaceAgentBackgroundAgents {
	var result tuttigenerated.WorkspaceAgentBackgroundAgents
	if !decodeTypedAgentSessionField(raw, &result) || result.Count < 0 || result.Items == nil {
		return nil
	}
	return &result
}

func generatedAgentSessionGoal(raw *agentactivitybiz.SessionGoal) *tuttigenerated.WorkspaceAgentSessionGoal {
	var result tuttigenerated.WorkspaceAgentSessionGoal
	if !decodeTypedAgentSessionField(raw, &result) || strings.TrimSpace(result.Objective) == "" || !result.Status.Valid() {
		return nil
	}
	return &result
}

func decodeTypedAgentSessionField(raw any, target any) bool {
	if raw == nil {
		return false
	}
	data, err := json.Marshal(raw)
	if err != nil || json.Unmarshal(data, target) != nil {
		return false
	}
	return true
}
