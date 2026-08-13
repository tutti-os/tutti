package host

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

const (
	ConnectorSummaryKeyMaxBytes         = 128
	ConnectorSummaryNameMaxBytes        = 256
	ConnectorSummaryDescriptionMaxBytes = 16 * 1024
	ConnectorInterfaceMaxCount          = 8
	ConnectorInterfaceFieldMaxBytes     = 512
	ConnectorSkillMaxCount              = 128
	ConnectorSkillNameMaxBytes          = 128
	ConnectorSkillTitleMaxBytes         = 256
	ConnectorSkillDescriptionMaxBytes   = 4 * 1024
	ConnectorSkillProjectionMaxBytes    = 512 * 1024
)

// ValidateConnectorSummary validates the complete process-boundary discovery
// projection produced by an exact runtime reconcile.
func ValidateConnectorSummary(summary ConnectorSummary, expectedKey string) error {
	if strings.TrimSpace(summary.Key) == "" || summary.Key != expectedKey {
		return errors.New("connector summary key does not match the reconciled Connector")
	}
	if err := validateSummaryText("key", summary.Key, ConnectorSummaryKeyMaxBytes, true); err != nil {
		return err
	}
	if err := validateSummaryText("name", summary.Name, ConnectorSummaryNameMaxBytes, true); err != nil {
		return err
	}
	if err := validateSummaryText("description", summary.Description, ConnectorSummaryDescriptionMaxBytes, false); err != nil {
		return err
	}
	if err := ValidateConnectorSkillSummaries(summary.Skills); err != nil {
		return err
	}
	if len(summary.Interfaces) == 0 || len(summary.Interfaces) > ConnectorInterfaceMaxCount {
		return fmt.Errorf("connector interface count must be between 1 and %d", ConnectorInterfaceMaxCount)
	}
	seen := make(map[string]struct{}, len(summary.Interfaces))
	for _, item := range summary.Interfaces {
		if item.Kind != "mcp" && item.Kind != "cli" {
			return fmt.Errorf("unsupported connector interface kind %q", item.Kind)
		}
		if _, exists := seen[item.Kind]; exists {
			return fmt.Errorf("duplicate connector interface kind %q", item.Kind)
		}
		seen[item.Kind] = struct{}{}
		for name, value := range map[string]string{
			"kind": item.Kind, "serverName": item.ServerName, "toolPrefix": item.ToolPrefix,
			"command": item.Command, "status": item.Status,
		} {
			if err := validateSummaryText("interface "+name, value, ConnectorInterfaceFieldMaxBytes, name == "kind" || name == "status"); err != nil {
				return err
			}
		}
		if item.Status != string(RuntimeReadinessReady) {
			return fmt.Errorf("connector interface %q is not ready", item.Kind)
		}
		if item.Kind == "mcp" && strings.TrimSpace(item.ServerName) == "" {
			return errors.New("connector MCP interface serverName is required")
		}
		if item.Kind == "cli" && strings.TrimSpace(item.Command) == "" {
			return errors.New("connector CLI interface command is required")
		}
	}
	return nil
}

func validateSummaryText(name, value string, limit int, required bool) error {
	if !utf8.ValidString(value) {
		return fmt.Errorf("connector summary %s must be valid UTF-8", name)
	}
	if len(value) > limit {
		return fmt.Errorf("connector summary %s exceeds %d bytes", name, limit)
	}
	if required && strings.TrimSpace(value) == "" {
		return fmt.Errorf("connector summary %s is required", name)
	}
	return nil
}

// ValidateConnectorSkillSummaries enforces the process-boundary size contract
// for Connector discovery metadata. Skill bodies are deliberately excluded.
func ValidateConnectorSkillSummaries(summaries []ConnectorSkillSummary) error {
	if len(summaries) > ConnectorSkillMaxCount {
		return fmt.Errorf("connector Skill count exceeds %d", ConnectorSkillMaxCount)
	}
	total := 0
	for _, summary := range summaries {
		if err := ValidateConnectorSkillSummary(summary); err != nil {
			return err
		}
		total += len(summary.Name) + len(summary.Title) + len(summary.Description)
		if total > ConnectorSkillProjectionMaxBytes {
			return fmt.Errorf("connector Skill summary projection exceeds %d bytes", ConnectorSkillProjectionMaxBytes)
		}
	}
	return nil
}

func ValidateConnectorSkillSummary(summary ConnectorSkillSummary) error {
	fields := []struct {
		name  string
		value string
		limit int
	}{
		{name: "name", value: summary.Name, limit: ConnectorSkillNameMaxBytes},
		{name: "title", value: summary.Title, limit: ConnectorSkillTitleMaxBytes},
		{name: "description", value: summary.Description, limit: ConnectorSkillDescriptionMaxBytes},
	}
	for _, field := range fields {
		if !utf8.ValidString(field.value) {
			return fmt.Errorf("connector Skill %s must be valid UTF-8", field.name)
		}
		if len(field.value) > field.limit {
			return fmt.Errorf("connector Skill %s exceeds %d bytes", field.name, field.limit)
		}
	}
	if strings.TrimSpace(summary.Name) == "" || strings.TrimSpace(summary.Title) == "" || strings.TrimSpace(summary.Description) == "" {
		return errors.New("connector Skill name, title, and description are required")
	}
	return nil
}
