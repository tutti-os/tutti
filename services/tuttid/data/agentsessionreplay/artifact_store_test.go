package agentsessionreplay

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func completeArtifactCandidate(
	t *testing.T,
	store *Store,
	recording replay.Recording,
) replay.ArtifactLayout {
	t.Helper()
	layout, err := store.Prepare(context.Background(), recording)
	if err != nil {
		t.Fatal(err)
	}
	recording.ArtifactKey = layout.StorageKey
	if err := store.WriteScenario(context.Background(), recording, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendActivityEvent(context.Background(), recording, replay.ActivityEvent{
		SchemaVersion: replay.CassetteSchemaVersion, Sequence: 1,
		Kind: replay.ActivityEventKindDirectStimulus, Type: "session.send",
		EventID: "event-1", ScopeID: recording.ScopeID, OccurredAtMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	for path, contents := range map[string]string{
		layout.ProviderTapeKey + "/manifest.json": `{"schemaVersion":2,"status":"complete"}` + "\n",
		layout.ProviderTapeKey + "/frames.jsonl":  "",
		layout.ExpectedFixtureKey:                 "{}\n",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return layout
}

func TestArtifactStorePublishesAndVerifiesSharedCassetteSchema(t *testing.T) {
	store := &Store{
		StateDir: t.TempDir(),
	}
	recording := replay.Recording{
		ID: "recording-1", ScopeID: "workspace-1", AgentTargetID: "local:codex",
		Name:               "2026-07-28T10:00:00.000Z",
		RootAgentSessionID: "session-1", Mode: replay.ScenarioModeCreateSession,
		RecordingAtUnixMS: 1, StoppedAtUnixMS: 2,
	}
	layout := completeArtifactCandidate(t, store, recording)
	artifact, err := store.Publish(context.Background(), recording, "cassette-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(layout.StorageKey); !os.IsNotExist(err) {
		t.Fatalf("candidate still exists: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(artifact.Layout.StorageKey, replay.CassetteManifestFile))
	if err != nil {
		t.Fatal(err)
	}
	var manifest replay.CassetteManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.ScopeID != "workspace-1" ||
		manifest.ID != "cassette-1" ||
		manifest.TotalBytes <= 0 {
		t.Fatalf("manifest = %#v", manifest)
	}
	checkpointsRaw, err := os.ReadFile(
		filepath.Join(artifact.Layout.StorageKey, replay.CheckpointsFile),
	)
	if err != nil {
		t.Fatal(err)
	}
	var checkpoints []replay.ReplayCheckpoint
	for _, line := range strings.Split(strings.TrimSpace(string(checkpointsRaw)), "\n") {
		var checkpoint replay.ReplayCheckpoint
		if err := json.Unmarshal([]byte(line), &checkpoint); err != nil {
			t.Fatal(err)
		}
		checkpoints = append(checkpoints, checkpoint)
	}
	if err := replay.ValidateReplayCheckpoints(checkpoints, 1); err != nil {
		t.Fatal(err)
	}
	if len(checkpoints) != 2 ||
		checkpoints[0].Kind != replay.ReplayCheckpointKindBootstrap ||
		checkpoints[1].AfterActivityEventSequence != 1 {
		t.Fatalf("checkpoints = %#v", checkpoints)
	}
	resolved, err := store.Resolve(context.Background(), artifact.Cassette)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Cassette.ID != artifact.Cassette.ID {
		t.Fatalf("resolved = %#v", resolved)
	}
	renamed, err := store.RenameCassette(context.Background(), artifact.Cassette, "checkout regression")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Cassette.Name != "checkout regression" ||
		renamed.Cassette.ManifestSHA256 == artifact.Cassette.ManifestSHA256 {
		t.Fatalf("renamed = %#v", renamed.Cassette)
	}
	raw, err = os.ReadFile(filepath.Join(artifact.Layout.StorageKey, replay.CassetteManifestFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Name != "checkout regression" {
		t.Fatalf("manifest name = %q", manifest.Name)
	}
	if err := os.WriteFile(
		filepath.Join(artifact.Layout.StorageKey, replay.ProviderFramesFile),
		[]byte("corrupt"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Resolve(context.Background(), artifact.Cassette); err == nil {
		t.Fatal("corrupt cassette was accepted")
	}
}

func TestArtifactStoreRejectsUnrelatedFile(t *testing.T) {
	store := &Store{
		StateDir: t.TempDir(),
	}
	recording := replay.Recording{
		ID: "recording-1", ScopeID: "workspace-1", AgentTargetID: "local:codex",
		Name:               "2026-07-28T10:00:00.000Z",
		RootAgentSessionID: "session-1", Mode: replay.ScenarioModeCreateSession,
	}
	layout := completeArtifactCandidate(t, store, recording)
	if err := os.WriteFile(filepath.Join(layout.StorageKey, "desktop.log"), []byte("log"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Publish(context.Background(), recording, "cassette-1", 1); err == nil ||
		!strings.Contains(err.Error(), "unrelated file") {
		t.Fatalf("Publish error = %v", err)
	}
}

func TestArtifactStoreMakesActivityEventAssetPortable(t *testing.T) {
	stateDir := t.TempDir()
	asset := filepath.Join(stateDir, "agent-prompt-assets", "workspace-1", "image.png")
	if err := os.MkdirAll(filepath.Dir(asset), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(asset, []byte("image bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &Store{StateDir: stateDir}
	recording := replay.Recording{ID: "recording-1", ScopeID: "workspace-1"}
	layout, err := store.Prepare(context.Background(), recording)
	if err != nil {
		t.Fatal(err)
	}
	recording.ArtifactKey = layout.StorageKey
	if err := store.AppendActivityEvent(context.Background(), recording, replay.ActivityEvent{
		SchemaVersion: replay.CassetteSchemaVersion, Sequence: 1,
		Kind: replay.ActivityEventKindIntent, Type: "submit/requested",
		EventID: "event-1", ScopeID: "workspace-1", OccurredAtMS: 1,
		Payload: map[string]any{"content": []map[string]any{{
			"type": "image", "path": asset, "mimeType": "image/png",
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(layout.StorageKey, replay.ActivityEventsFile))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), asset) ||
		!strings.Contains(string(raw), `"data":"aW1hZ2UgYnl0ZXM="`) {
		t.Fatalf("event = %s", raw)
	}
}
