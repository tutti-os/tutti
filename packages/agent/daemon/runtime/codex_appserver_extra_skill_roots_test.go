package agentruntime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestTuttiAgentStartSetsExtraSkillRootsBeforeThread(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(transport, LegacyHostMetadata())
	root := filepath.Join(t.TempDir(), "bundle", "skills")
	session := testAppServerSession()
	session.Provider = ProviderTuttiAgent
	extraRoots := mustEncodeExtraRoots(t, root)
	session.Env = []string{
		"SESSION_ENV=1",
		tuttiAgentExtraSkillRootsEnv + "=" + extraRoots,
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	params := appServerRequestParams(t, transport.conn, appServerMethodSkillsExtraRootsSet)
	if got := appServerStringSlice(params["extraRoots"]); !slices.Equal(got, []string{root}) {
		t.Fatalf("skills/extraRoots/set roots = %#v, want %#v", got, []string{root})
	}
	methods := appServerSentMethods(t, transport.conn)
	assertAppServerMethodOrder(t, methods,
		appServerMethodInitialize,
		appServerMethodInitialized,
		appServerMethodSkillsExtraRootsSet,
		appServerMethodThreadStart,
	)
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	if _, found := lastEnvironmentValue(transport.specs[0].Env, tuttiAgentExtraSkillRootsEnv); found {
		t.Fatalf("internal extra roots metadata leaked to child env: %#v", transport.specs[0].Env)
	}
	if !containsString(transport.specs[0].Env, "SESSION_ENV=1") {
		t.Fatalf("process env lost ordinary session env: %#v", transport.specs[0].Env)
	}
}

func TestCodexStartSetsPreparedExtraSkillRootsBeforeThread(t *testing.T) {
	t.Parallel()
	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	root := filepath.Join(t.TempDir(), "session-skills")
	session := testAppServerSession()
	session.Provider = ProviderCodex
	session.Env = []string{tuttiAgentExtraSkillRootsEnv + "=" + mustEncodeExtraRoots(t, root)}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	params := appServerRequestParams(t, transport.conn, appServerMethodSkillsExtraRootsSet)
	if got := appServerStringSlice(params["extraRoots"]); !slices.Equal(got, []string{root}) {
		t.Fatalf("skills/extraRoots/set roots = %#v, want %#v", got, []string{root})
	}
	assertAppServerMethodOrder(t, appServerSentMethods(t, transport.conn),
		appServerMethodInitialize,
		appServerMethodInitialized,
		appServerMethodSkillsExtraRootsSet,
		appServerMethodThreadStart,
	)
}

func TestTuttiAgentStartStabilizesSystemSkillsBeforeThread(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(transport, LegacyHostMetadata())
	temporary := t.TempDir()
	home := filepath.Join(temporary, "run", "tutti-agent-home")
	writeTestSystemSkills(t, filepath.Join(home, "skills", ".system"), "same-version")
	stableStore := filepath.Join(temporary, "state", "system-skill-bundles")
	managedSkillsRoot := filepath.Join(temporary, "stable-managed-skills")
	session := testAppServerSession()
	session.Provider = ProviderTuttiAgent
	extraRoots := mustEncodeExtraRoots(t, managedSkillsRoot)
	session.Env = []string{
		tuttiAgentHomeEnv + "=" + home,
		tuttiAgentStableSystemSkillsEnv + "=" + stableStore,
		tuttiAgentExtraSkillRootsEnv + "=" + extraRoots,
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	systemRoot := filepath.Join(home, "skills", ".system")
	info, err := os.Lstat(systemRoot)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		canonicalStore, err := filepath.EvalSymlinks(stableStore)
		if err != nil {
			t.Fatal(err)
		}
		resolved, resolveErr := filepath.EvalSymlinks(systemRoot)
		if resolveErr == nil && resolved != filepath.Clean(systemRoot) {
			if !strings.HasPrefix(resolved, filepath.Join(canonicalStore, "v1")+string(filepath.Separator)) {
				t.Fatalf("stable system skill link target = %q", resolved)
			}
		} else {
			if info.Mode()&os.ModeSymlink != 0 {
				t.Fatalf("system skill root mode = %s, want junction or directory copy", info.Mode())
			}
			if _, err := os.Stat(filepath.Join(systemRoot, "skill-creator", "SKILL.md")); err != nil {
				t.Fatalf("copied system skill missing: %v", err)
			}
		}
	} else {
		if info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("system skill root mode = %s, want symlink", info.Mode())
		}
		resolved, err := filepath.EvalSymlinks(systemRoot)
		if err != nil {
			t.Fatal(err)
		}
		canonicalStore, err := filepath.EvalSymlinks(stableStore)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(resolved, filepath.Join(canonicalStore, "v1")+string(filepath.Separator)) {
			t.Fatalf("stable system skill target = %q", resolved)
		}
	}
	methods := appServerSentMethods(t, transport.conn)
	assertAppServerMethodOrder(t, methods,
		appServerMethodInitialize,
		appServerMethodInitialized,
		appServerMethodSkillsExtraRootsSet,
		appServerMethodThreadStart,
	)
	if _, found := lastEnvironmentValue(transport.specs[0].Env, tuttiAgentStableSystemSkillsEnv); found {
		t.Fatalf("internal system skill metadata leaked to child env: %#v", transport.specs[0].Env)
	}
}

func TestTuttiAgentResumeSetsExtraSkillRootsBeforeThread(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(transport, LegacyHostMetadata())
	root := filepath.Join(t.TempDir(), "bundle", "skills")
	session := testAppServerSession()
	session.Provider = ProviderTuttiAgent
	session.ProviderSessionID = "codex-thread-1"
	session.Env = []string{tuttiAgentExtraSkillRootsEnv + "=" + mustEncodeExtraRoots(t, root)}
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	methods := appServerSentMethods(t, transport.conn)
	assertAppServerMethodOrder(t, methods,
		appServerMethodInitialize,
		appServerMethodInitialized,
		appServerMethodSkillsExtraRootsSet,
		appServerMethodThreadResume,
	)
}

func TestTuttiAgentExtraSkillRootsFailureStopsBeforeThread(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.server.extraRootsError = true
	adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(transport, LegacyHostMetadata())
	session := testAppServerSession()
	session.Provider = ProviderTuttiAgent
	session.Env = []string{tuttiAgentExtraSkillRootsEnv + "=" + mustEncodeExtraRoots(t, filepath.Join(t.TempDir(), "stable-skills"))}
	_, err := adapter.Start(context.Background(), session)
	if err == nil || !strings.Contains(err.Error(), "configure tutti-agent extra skill roots") {
		t.Fatalf("Start error = %v, want extra roots failure", err)
	}
	if got := len(appServerRequestParamsList(t, transport.conn, appServerMethodThreadStart)); got != 0 {
		t.Fatalf("thread/start requests = %d, want 0", got)
	}
}

func TestTuttiAgentExtraSkillRootsRejectInvalidMetadataBeforeSpawn(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(transport, LegacyHostMetadata())
	session := testAppServerSession()
	session.Provider = ProviderTuttiAgent
	session.Env = []string{tuttiAgentExtraSkillRootsEnv + `=["relative/skills"]`}
	if _, err := adapter.Start(context.Background(), session); err == nil {
		t.Fatal("Start error = nil, want relative root rejection")
	}
	if len(transport.specs) != 0 {
		t.Fatalf("process starts = %d, want validation before spawn", len(transport.specs))
	}
}

func mustEncodeExtraRoots(t *testing.T, roots ...string) string {
	t.Helper()
	encoded, err := json.Marshal(roots)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func appServerStringSlice(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, asString(item))
	}
	return result
}

func writeTestSystemSkills(t *testing.T, root string, marker string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "skill-creator"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, systemSkillsMarkerFile), []byte(marker+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "skill-creator", "SKILL.md"),
		[]byte("---\nname: skill-creator\ndescription: test\n---\n"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
}

func appServerSentMethods(t *testing.T, conn *scriptedAppServerConnection) []string {
	t.Helper()
	conn.mu.Lock()
	sent := append([][]byte(nil), conn.sent...)
	conn.mu.Unlock()
	methods := make([]string, 0, len(sent))
	for _, data := range sent {
		for _, line := range acpScanLines(data) {
			var request struct {
				Method string `json:"method"`
			}
			if err := json.Unmarshal([]byte(line), &request); err != nil {
				t.Fatalf("unmarshal app-server request: %v", err)
			}
			if request.Method != "" {
				methods = append(methods, request.Method)
			}
		}
	}
	return methods
}

func assertAppServerMethodOrder(t *testing.T, methods []string, ordered ...string) {
	t.Helper()
	last := -1
	for _, method := range ordered {
		index := slices.Index(methods, method)
		if index < 0 {
			t.Fatalf("method %q missing from %#v", method, methods)
		}
		if index <= last {
			t.Fatalf("method order = %#v, want %#v", methods, ordered)
		}
		last = index
	}
}
