package api

import (
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func agentPromptContentFromGenerated(content []tuttigenerated.AgentPromptContentBlock) []agentservice.PromptContentBlock {
	result := make([]agentservice.PromptContentBlock, 0, len(content))
	for _, block := range content {
		item := agentservice.PromptContentBlock{
			Type: string(block.Type),
		}
		if block.Text != nil {
			item.Text = *block.Text
		}
		if block.MimeType != nil {
			item.MimeType = string(*block.MimeType)
		}
		if block.Data != nil {
			item.Data = *block.Data
		}
		if block.Url != nil {
			item.URL = *block.Url
		}
		if block.AttachmentId != nil {
			item.AttachmentID = *block.AttachmentId
		}
		if block.Name != nil {
			item.Name = *block.Name
		}
		if block.Path != nil {
			item.Path = *block.Path
		}
		if block.ConnectorKey != nil {
			item.ConnectorKey = *block.ConnectorKey
		}
		result = append(result, item)
	}
	return result
}
