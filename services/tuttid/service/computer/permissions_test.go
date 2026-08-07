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

func TestParseWindowsDriverDoctor(t *testing.T) {
	doctor, err := parseWindowsDriverDoctor([]byte("driver diagnostic\n{\"ok\":true,\"probes\":[{\"label\":\"UI Automation\",\"status\":\"ok\"}]}"))
	if err != nil {
		t.Fatalf("parseWindowsDriverDoctor: %v", err)
	}
	if !doctor.OK {
		t.Fatalf("doctor = %#v, want ok", doctor)
	}
	if _, err := parseWindowsDriverDoctor([]byte(`{"ok":false}`)); err != nil {
		t.Fatalf("parseWindowsDriverDoctor false result: %v", err)
	}
}

func boolPtr(value bool) *bool {
	return &value
}
