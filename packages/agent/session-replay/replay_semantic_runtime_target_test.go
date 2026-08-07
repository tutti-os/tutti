package sessionreplay

import "testing"

func TestResolveSemanticRuntimeTargetBindsOneTransientUserPerWorkspace(t *testing.T) {
	profile := AgentSemanticProfile()
	workspaceID, userID, resolvedProfile, err := resolveSemanticRuntimeTarget([]SemanticRegistration{
		{WorkspaceID: " workspace-1 ", UserID: " user-1 ", Profile: profile},
		{WorkspaceID: "workspace-1", UserID: "user-1", Profile: profile},
	})
	if err != nil {
		t.Fatal(err)
	}
	if workspaceID != "workspace-1" || userID != "user-1" || resolvedProfile != profile {
		t.Fatalf("runtime target = (%q, %q, %#v)", workspaceID, userID, resolvedProfile)
	}
	if _, _, _, err := resolveSemanticRuntimeTarget([]SemanticRegistration{
		{WorkspaceID: "workspace-1", UserID: "user-1", Profile: profile},
		{WorkspaceID: "workspace-1", UserID: "user-2", Profile: profile},
	}); err == nil {
		t.Fatal("mixed runtime users were accepted")
	}
	if _, _, _, err := resolveSemanticRuntimeTarget([]SemanticRegistration{{
		WorkspaceID: "workspace-1",
		Profile:     profile,
	}}); err == nil {
		t.Fatal("missing runtime user was accepted")
	}
}
