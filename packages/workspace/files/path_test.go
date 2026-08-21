package workspacefiles

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestNormalizeLogicalPathWithinRoot(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    LogicalPath
		wantErr error
	}{
		{name: "empty defaults to root", input: "", want: "/"},
		{name: "relative path stays under root", input: "src/App.tsx", want: "/src/App.tsx"},
		{name: "collapses duplicate separators", input: "/Users/test/project//src///", want: "/Users/test/project/src"},
		{name: "cleans dot segments", input: "/Users/test/project/src/../docs", want: "/Users/test/project/docs"},
		{name: "normalizes backslashes", input: "src\\App.tsx", want: "/src/App.tsx"},
		{name: "normalizes Windows drive absolute path", input: `C:\\Users\\test\\project`, want: "/C:/Users/test/project"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NormalizeLogicalPath(tt.input)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("error = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizeLogicalPath() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("NormalizeLogicalPath() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNormalizeLogicalPathWithinWindowsRootAcceptsDriveAbsolutePath(t *testing.T) {
	for _, input := range []string{
		`C:\\Users\\test\\project`,
		`c:/Users/test/project`,
		`/c/Users/test/project`,
	} {
		t.Run(input, func(t *testing.T) {
			got, err := NormalizeLogicalPathWithinRoot(
				input,
				`C:\\Users\\test\\project`,
			)
			if err != nil {
				t.Fatalf("NormalizeLogicalPathWithinRoot() error = %v", err)
			}
			if got != "/C:/Users/test/project" {
				t.Fatalf("NormalizeLogicalPathWithinRoot() = %q, want /C:/Users/test/project", got)
			}
		})
	}
}

func TestNormalizeLogicalPathWithinWindowsRootKeepsPosixDriveLikePathPosix(t *testing.T) {
	got, err := NormalizeLogicalPathWithinRoot("/c/Users/test/project", "/")
	if err != nil {
		t.Fatalf("NormalizeLogicalPathWithinRoot() error = %v", err)
	}
	if got != "/c/Users/test/project" {
		t.Fatalf("NormalizeLogicalPathWithinRoot() = %q, want /c/Users/test/project", got)
	}
}

func TestLogicalRelativePathMatchesWindowsDrivePathsCaseInsensitively(t *testing.T) {
	got, err := LogicalRelativePath(
		"/c:/users/test/project/src/App.tsx",
		`C:\\Users\\test\\project`,
	)
	if err != nil {
		t.Fatalf("LogicalRelativePath() error = %v", err)
	}
	if got != "src/App.tsx" {
		t.Fatalf("LogicalRelativePath() = %q, want src/App.tsx", got)
	}
}

func TestNormalizeLogicalPathWithinExplicitRootRejectsEscapes(t *testing.T) {
	root := "/Users/test/project"
	tests := []struct {
		name    string
		input   string
		want    LogicalPath
		wantErr error
	}{
		{name: "empty defaults to explicit root", input: "", want: "/Users/test/project"},
		{name: "relative path stays under explicit root", input: "src/App.tsx", want: "/Users/test/project/src/App.tsx"},
		{name: "rejects absolute escape", input: "/etc/passwd", wantErr: ErrPathEscapesRoot},
		{name: "rejects parent escape", input: "/Users/test/project/../../etc", wantErr: ErrPathEscapesRoot},
		{name: "rejects relative parent escape", input: "../etc", wantErr: ErrPathEscapesRoot},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NormalizeLogicalPathWithinRoot(tt.input, root)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("error = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizeLogicalPathWithinRoot() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("NormalizeLogicalPathWithinRoot() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestJoinPhysicalPathRejectsEscape(t *testing.T) {
	root := WorkspaceRoot{
		LogicalRoot:  "/workspace",
		PhysicalRoot: filepath.Join(t.TempDir(), "workspace"),
	}
	got, err := JoinPhysicalPath(root, "/workspace/src/App.tsx")
	if err != nil {
		t.Fatalf("JoinPhysicalPath() error = %v", err)
	}
	want := filepath.Join(root.PhysicalRoot, "src", "App.tsx")
	if got != want {
		t.Fatalf("JoinPhysicalPath() = %q, want %q", got, want)
	}

	_, err = JoinPhysicalPath(root, "/etc/passwd")
	if !errors.Is(err, ErrPathEscapesRoot) {
		t.Fatalf("JoinPhysicalPath escape error = %v, want %v", err, ErrPathEscapesRoot)
	}
}

func TestIsPhysicalPathWithinRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "workspace")
	if !IsPhysicalPathWithinRoot(root, filepath.Join(root, "src", "main.go")) {
		t.Fatal("child path should be within root")
	}
	if !IsPhysicalPathWithinRoot(root, root) {
		t.Fatal("root path should be within root")
	}
	if IsPhysicalPathWithinRoot(root, filepath.Join(root, "..", "outside")) {
		t.Fatal("sibling path should not be within root")
	}
}
