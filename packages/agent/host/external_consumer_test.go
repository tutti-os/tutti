package agenthost

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestExternalConsumerCompilesWithoutDaemonDependency(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve Host module path")
	}
	hostDir := filepath.Dir(currentFile)
	fixtureDir := filepath.Join(hostDir, "testdata", "external-consumer")
	tempDir := t.TempDir()

	template, err := os.ReadFile(filepath.Join(fixtureDir, "go.mod.tmpl"))
	if err != nil {
		t.Fatalf("read external consumer go.mod: %v", err)
	}
	replacements := map[string]string{
		"{{HOST_DIR}}":        hostDir,
		"{{STORE_DIR}}":       filepath.Join(hostDir, "..", "store-sqlite"),
		"{{CANONICAL_DIR}}":   filepath.Join(hostDir, "..", "store-sqlite", "canonical"),
		"{{REPLICATION_DIR}}": filepath.Join(hostDir, "..", "activity-replication"),
	}
	goMod := string(template)
	for marker, path := range replacements {
		goMod = strings.ReplaceAll(goMod, marker, filepath.ToSlash(path))
	}
	if err := os.WriteFile(filepath.Join(tempDir, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatalf("write external consumer go.mod: %v", err)
	}
	consumer, err := os.ReadFile(filepath.Join(fixtureDir, "consumer.go"))
	if err != nil {
		t.Fatalf("read external consumer source: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "consumer.go"), consumer, 0o600); err != nil {
		t.Fatalf("write external consumer source: %v", err)
	}

	runExternalGo(t, tempDir, "test", "-mod=mod", ".")
	dependencies := runExternalGo(t, tempDir, "list", "-mod=mod", "-deps", ".")
	modules := runExternalGo(t, tempDir, "list", "-mod=mod", "-m", "all")
	for _, forbidden := range []string{
		"github.com/tutti-os/tutti/packages/agent/daemon",
		"github.com/tutti-os/tutti/services/tuttid",
		"sidecar",
	} {
		if strings.Contains(dependencies, forbidden) || strings.Contains(modules, forbidden) {
			t.Fatalf("external Host consumer dependency closure contains %q", forbidden)
		}
	}
}

func runExternalGo(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("go", args...)
	command.Dir = dir
	command.Env = append(os.Environ(), "GOWORK=off")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("go %s failed: %v\n%s", strings.Join(args, " "), err, output)
	}
	return string(output)
}
