package main

import (
	"context"
	"fmt"

	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func reconcileIssueAttachmentFiles(
	ctx context.Context,
	store workspacedata.CatalogStore,
) (workspacedata.IssueAttachmentFiles, error) {
	files := workspacedata.IssueAttachmentFiles{StateDir: tuttitypes.DefaultStateDir()}
	refs, ok := store.(workspacedata.IssueAttachmentReferenceReader)
	if !ok {
		return files, nil
	}
	if err := files.Reconcile(ctx, refs); err != nil {
		return workspacedata.IssueAttachmentFiles{}, fmt.Errorf("reconcile issue attachments: %w", err)
	}
	return files, nil
}
