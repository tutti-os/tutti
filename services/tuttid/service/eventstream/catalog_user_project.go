package eventstream

import (
	"fmt"
	"strings"
)

func validateUserProjectUpdatedPayload(payload []byte) error {
	var decoded struct {
		Projects *[]struct {
			ID               string `json:"id"`
			Path             string `json:"path"`
			Label            string `json:"label"`
			SectionKey       string `json:"sectionKey"`
			CreatedAtUnixMS  *int64 `json:"createdAtUnixMs"`
			UpdatedAtUnixMS  *int64 `json:"updatedAtUnixMs"`
			LastUsedAtUnixMS *int64 `json:"lastUsedAtUnixMs"`
			PinnedAtUnixMS   *int64 `json:"pinnedAtUnixMs"`
		} `json:"projects"`
	}
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if decoded.Projects == nil {
		return fmt.Errorf("projects is required")
	}
	for index, project := range *decoded.Projects {
		if strings.TrimSpace(project.ID) == "" {
			return fmt.Errorf("projects[%d].id is required", index)
		}
		if strings.TrimSpace(project.Path) == "" {
			return fmt.Errorf("projects[%d].path is required", index)
		}
		if strings.TrimSpace(project.Label) == "" {
			return fmt.Errorf("projects[%d].label is required", index)
		}
		if strings.TrimSpace(project.SectionKey) == "" {
			return fmt.Errorf("projects[%d].sectionKey is required", index)
		}
		if project.CreatedAtUnixMS == nil {
			return fmt.Errorf("projects[%d].createdAtUnixMs is required", index)
		}
		if *project.CreatedAtUnixMS < 0 {
			return fmt.Errorf("projects[%d].createdAtUnixMs must not be negative", index)
		}
		if project.UpdatedAtUnixMS == nil {
			return fmt.Errorf("projects[%d].updatedAtUnixMs is required", index)
		}
		if *project.UpdatedAtUnixMS < 0 {
			return fmt.Errorf("projects[%d].updatedAtUnixMs must not be negative", index)
		}
		if project.LastUsedAtUnixMS == nil {
			return fmt.Errorf("projects[%d].lastUsedAtUnixMs is required", index)
		}
		if *project.LastUsedAtUnixMS < 0 {
			return fmt.Errorf("projects[%d].lastUsedAtUnixMs must not be negative", index)
		}
		if project.PinnedAtUnixMS == nil {
			return fmt.Errorf("projects[%d].pinnedAtUnixMs is required", index)
		}
		if *project.PinnedAtUnixMS < 0 {
			return fmt.Errorf("projects[%d].pinnedAtUnixMs must not be negative", index)
		}
	}
	return nil
}
