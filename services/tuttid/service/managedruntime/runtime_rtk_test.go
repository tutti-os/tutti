package managedruntime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolvedRuntimeForRTKSaverProfileExposesOnlyRTK(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "rtk", "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(binDir, rtkBinaryName())
	if err := os.WriteFile(executable, []byte("rtk"), 0o700); err != nil {
		t.Fatal(err)
	}
	resolved, err := (DefaultResolver{Environ: func() []string {
		return []string{"PATH=/host/bin"}
	}}).resolvedRuntimeForComponents(root, []string{"rtk"})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.RTK != executable || resolved.Node != "" || resolved.Python != "" {
		t.Fatalf("resolved runtime = %#v", resolved)
	}
	if len(resolved.BinDirs) != 1 || resolved.BinDirs[0] != binDir {
		t.Fatalf("RTK bin dirs = %#v", resolved.BinDirs)
	}
	if got := EnvValue(resolved.EnvOverrides, "TUTTI_APP_RTK"); got != executable {
		t.Fatalf("TUTTI_APP_RTK = %q, want %q", got, executable)
	}
	if !appRuntimeComponentReady(root, "rtk") {
		t.Fatal("prepared RTK component is not ready")
	}
}
