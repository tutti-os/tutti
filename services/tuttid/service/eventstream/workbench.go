package eventstream

import (
	"context"
	"encoding/json"
	"fmt"

	workbenchbiz "github.com/tutti-os/tutti/services/tuttid/biz/workbench"
)

type WorkbenchNodeLaunchPublisher struct {
	Service *Service
}

func (p WorkbenchNodeLaunchPublisher) PublishWorkbenchNodeLaunchRequested(
	ctx context.Context,
	request workbenchbiz.NodeLaunchRequest,
) error {
	if p.Service == nil {
		return nil
	}
	request = workbenchbiz.NormalizeNodeLaunchRequest(request)
	if request.WorkspaceID == "" || request.TypeID == "" || request.Source == "" {
		return fmt.Errorf("workbench node launch request requires workspaceId, typeId, and source")
	}
	payload := workbenchNodeLaunchRequestedPayload{
		WorkspaceID:  request.WorkspaceID,
		TypeID:       request.TypeID,
		Source:       request.Source,
		LaunchSource: request.LaunchSource,
		DockEntryID:  request.DockEntryID,
		RequestID:    request.RequestID,
		Payload:      request.Payload,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal workbench node launch requested payload: %w", err)
	}
	return p.Service.PublishFromServerScoped(
		ctx,
		TopicWorkspaceWorkbenchNodeLaunchRequested,
		encoded,
		EventScope{WorkspaceID: request.WorkspaceID},
	)
}
