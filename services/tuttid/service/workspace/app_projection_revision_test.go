package workspace

import (
	"testing"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestWorkspaceAppProjectionRejectsOlderRuntimeState(t *testing.T) {
	service := &AppCenterService{}
	newer := int64(2)
	failurePhase := workspacebiz.AppFailurePhaseStarting
	failureReason := "health check failed"
	failed, changed := service.withChangedRevision(workspacebiz.WorkspaceApp{
		Package: workspacebiz.AppPackage{AppID: "app-1"},
		Runtime: workspacebiz.AppRuntimeState{
			Status: workspacebiz.AppRuntimeStatusFailed, UpdatedAtUnixMs: &newer,
			FailurePhase: &failurePhase, FailureReason: &failureReason, LastError: &failureReason,
		},
	}, "ws-1", "app-1")
	if !changed || failed.StateRevision != 1 {
		t.Fatalf("failed projection = (%#v, %v), want revision 1", failed, changed)
	}

	older := int64(1)
	stale, changed := service.withChangedRevision(workspacebiz.WorkspaceApp{
		Package: workspacebiz.AppPackage{AppID: "app-1"},
		Runtime: workspacebiz.AppRuntimeState{
			Status: workspacebiz.AppRuntimeStatusPreparing, UpdatedAtUnixMs: &older,
		},
		InstallProgress: &workspacebiz.AppInstallProgress{
			UserPhase: workspacebiz.AppInstallUserPhaseStarting, OverallPercent: 100,
		},
	}, "ws-1", "app-1")
	if changed || stale.StateRevision != failed.StateRevision {
		t.Fatalf("stale projection = (%#v, %v), want rejected at revision %d", stale, changed, failed.StateRevision)
	}
}
