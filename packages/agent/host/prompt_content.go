package agenthost

type preparedPromptContent struct {
	Persisted   []PromptContentBlock
	Hydrated    []PromptContentBlock
	DisplayText string
}

func (h *Host) prepareContent(workspaceID, sessionID string, content []PromptContentBlock) (preparedPromptContent, error) {
	if h.attachments == nil {
		cloned := append([]PromptContentBlock(nil), content...)
		return preparedPromptContent{
			Persisted: cloned,
			Hydrated:  append([]PromptContentBlock(nil), cloned...),
		}, nil
	}
	persisted, err := h.attachments.PersistRequestContent(workspaceID, sessionID, content)
	if err != nil {
		return preparedPromptContent{}, err
	}
	hydrated, err := h.attachments.HydrateRuntimeContent(workspaceID, sessionID, persisted)
	if err != nil {
		return preparedPromptContent{}, err
	}
	return preparedPromptContent{
		Persisted:   append([]PromptContentBlock(nil), persisted...),
		Hydrated:    append([]PromptContentBlock(nil), hydrated...),
		DisplayText: imageOnlyDisplayText(persisted),
	}, nil
}
