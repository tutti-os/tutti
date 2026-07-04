package computer

import (
	"reflect"
	"testing"
)

func TestParseComputerPermissionStatus(t *testing.T) {
	status, err := parseComputerPermissionStatus([]byte(`{
		"accessibility": true,
		"screen_recording": true,
		"screen_recording_capturable": true
	}`))
	if err != nil {
		t.Fatalf("parseComputerPermissionStatus returned error: %v", err)
	}
	if issues := computerPermissionIssues(status); len(issues) != 0 {
		t.Fatalf("computerPermissionIssues = %v, want none", issues)
	}
}

func TestParseComputerPermissionStatusToleratesDiagnosticOutput(t *testing.T) {
	status, err := parseComputerPermissionStatus([]byte(`cua-driver diagnostic
{
	"accessibility": true,
	"screen_recording": false,
	"screen_recording_capturable": true
}`))
	if err != nil {
		t.Fatalf("parseComputerPermissionStatus returned error: %v", err)
	}
	issues := computerPermissionIssues(status)
	if !reflect.DeepEqual(issues, []string{"missing Screen Recording"}) {
		t.Fatalf("computerPermissionIssues = %v, want missing Screen Recording", issues)
	}
}

func TestComputerPermissionIssuesRequiresBothPermissions(t *testing.T) {
	status := computerPermissionStatus{
		Accessibility:             boolPtr(false),
		ScreenRecording:           boolPtr(true),
		ScreenRecordingCapturable: boolPtr(false),
	}
	issues := computerPermissionIssues(status)
	want := []string{
		"missing Accessibility",
		"Screen Recording authorized but not capturable; restart CuaDriver and check again",
	}
	if !reflect.DeepEqual(issues, want) {
		t.Fatalf("computerPermissionIssues = %v, want %v", issues, want)
	}
}

func boolPtr(value bool) *bool {
	return &value
}
