package computer

import (
	"context"
	"errors"
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

func TestComputerPermissionIssuesAcceptsUnprobedCaptureAfterTCCGrants(t *testing.T) {
	status := computerPermissionStatus{
		Accessibility:   boolPtr(true),
		ScreenRecording: boolPtr(true),
	}
	if issues := computerPermissionIssues(status); len(issues) != 0 {
		t.Fatalf("computerPermissionIssues = %v, want none for an unprobed capture status", issues)
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

func TestEvaluateWindowsDriverDoctorAcceptsUsableWin32Fallback(t *testing.T) {
	output := []byte("\x1b[33mWARN\x1b[0m UIA health probe exceeded 2000ms; falling back to Win32-only window tools\n" + `{
		"ok": false,
		"probes": [{
			"label": "binary",
			"message": "cua-driver 0.18.0 (x86_64-windows)",
			"status": "ok"
		}]
	}`)
	if err := evaluateWindowsDriverDoctor(output, errors.New("exit status 1"), nil); err != nil {
		t.Fatalf("evaluateWindowsDriverDoctor degraded fallback: %v", err)
	}
}

func TestEvaluateWindowsDriverDoctorRejectsOrdinaryFailure(t *testing.T) {
	err := evaluateWindowsDriverDoctor(
		[]byte(`{"ok":false,"message":"interactive desktop unavailable"}`),
		errors.New("exit status 1"),
		nil,
	)
	if err == nil {
		t.Fatal("evaluateWindowsDriverDoctor ordinary failure returned nil")
	}
}

func TestEvaluateWindowsDriverDoctorRejectsUnexpectedHealthyNonzeroExit(t *testing.T) {
	err := evaluateWindowsDriverDoctor(
		[]byte(`{"ok":true}`),
		errors.New("exit status 1"),
		nil,
	)
	if err == nil {
		t.Fatal("evaluateWindowsDriverDoctor healthy nonzero exit returned nil")
	}
}

func TestEvaluateWindowsDriverDoctorRejectsMalformedOutput(t *testing.T) {
	if err := evaluateWindowsDriverDoctor([]byte("not json"), nil, nil); err == nil {
		t.Fatal("evaluateWindowsDriverDoctor malformed output returned nil")
	}
	if err := evaluateWindowsDriverDoctor([]byte("falling back to Win32-only window tools\nnot json"), errors.New("exit status 1"), nil); err == nil {
		t.Fatal("evaluateWindowsDriverDoctor malformed fallback output returned nil")
	}
	if err := evaluateWindowsDriverDoctor(nil, nil, nil); err == nil {
		t.Fatal("evaluateWindowsDriverDoctor empty output returned nil")
	}
}

func TestEvaluateWindowsDriverDoctorRejectsCancelledProbe(t *testing.T) {
	output := []byte(`{
		"ok": false,
		"message": "falling back to Win32-only window tools"
	}`)
	if err := evaluateWindowsDriverDoctor(output, errors.New("signal: killed"), context.DeadlineExceeded); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("evaluateWindowsDriverDoctor deadline error = %v, want deadline exceeded", err)
	}
}

func boolPtr(value bool) *bool {
	return &value
}
