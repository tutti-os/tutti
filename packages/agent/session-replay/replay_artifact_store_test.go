package sessionreplay

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func replayPrerequisitesForTest() ReplayPrerequisites {
	return ReplayPrerequisites{ComposerDefaults: ReplayComposerDefaults{
		Model:            "gpt-5.4",
		PermissionModeID: "default",
		ReasoningEffort:  "medium",
		Speed:            "normal",
	}}
}

func TestArtifactStorePrepareWritesNeutralBootstrapCheckpoint(t *testing.T) {
	store := &Store{StateDir: t.TempDir()}
	layout, err := store.Prepare(
		context.Background(),
		Recording{ID: "recording-bootstrap"},
	)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(layout.CheckpointPlanKey)
	if err != nil {
		t.Fatal(err)
	}
	var plan CheckpointPlan
	if err := json.Unmarshal(raw, &plan); err != nil {
		t.Fatal(err)
	}
	checkpoint := plan.Checkpoints[0]
	if checkpoint.Kind != "replay.bootstrap" ||
		len(checkpoint.Subjects) != 0 ||
		len(checkpoint.Readiness.All) != 0 {
		t.Fatalf("prepared bootstrap checkpoint = %#v", checkpoint)
	}
}

func completeArtifactCandidate(
	t *testing.T,
	store *Store,
	recording Recording,
) ArtifactLayout {
	t.Helper()
	layout, err := store.Prepare(context.Background(), recording)
	if err != nil {
		t.Fatal(err)
	}
	recording.ArtifactKey = layout.StorageKey
	if err := store.AppendActivityEvent(context.Background(), recording, ActivityEvent{
		SchemaVersion: CassetteSchemaVersion, Sequence: 1,
		Kind: ActivityEventKindDirectStimulus, Type: "session.send",
		EventID: "event-1", ScopeID: recording.ScopeID, OccurredAtMS: 1,
		Payload: map[string]any{"displayPrompt": recording.ScopeID},
	}); err != nil {
		t.Fatal(err)
	}
	turn := EntityAddress{
		Kind: EntityKindTurn,
		Origin: EntityOrigin{
			Source:                EntityOriginActivityEvent,
			ActivityEventSequence: 1,
		},
	}
	if err := store.WriteCheckpointPlan(context.Background(), recording, NewCheckpointPlan([]ReplayCheckpoint{
		{
			ID:      "checkpoint-0000",
			Index:   0,
			Kind:    "replay.bootstrap",
			Tags:    []string{"replay.bootstrap"},
			Trigger: CheckpointTrigger{Source: CheckpointTriggerBootstrap},
			Readiness: CheckpointReadiness{
				All: []ReadinessPredicate{},
			},
		},
		{
			ID:     "checkpoint-0001",
			Index:  1,
			Kind:   "turn.terminal",
			Tags:   []string{"turn.terminal"},
			Cursor: ReplayCursor{ActivityEventSequence: 1},
			Trigger: CheckpointTrigger{
				Source:                     CheckpointTriggerActivityBoundary,
				AfterActivityEventSequence: 1,
				BoundaryKind:               ActivityBoundarySingleEvent,
			},
			Subjects: []EntityAddress{turn},
			Readiness: CheckpointReadiness{All: []ReadinessPredicate{{
				Type: "turn.status", Subject: 0, Equals: "completed",
			}}},
		},
	})); err != nil {
		t.Fatal(err)
	}
	for path, contents := range map[string]string{
		layout.ProviderTapeKey + "/manifest.json": `{"schemaVersion":4,"projectionVersion":1,"status":"complete","connections":[{"connectionId":"connection-1","provider":"codex"}]}` + "\n",
		layout.ProviderTapeKey + "/frames.jsonl":  "",
		layout.ExpectedStateKey:                   `{"schemaVersion":1,"agent":{"rootSessionId":"session-1","sessions":[{"id":"session-1","kind":"root","agentTargetId":"local:codex","provider":"codex","providerSessionId":"provider-session-1","settings":{},"pinned":false,"turns":[],"messages":[],"interactions":[]}]},"tuttiMode":{"activations":[],"turnSnapshots":[]},"workflows":[],"issues":[]}` + "\n",
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

func TestMergeObservationJournalEntryRejectsIdentityConflicts(t *testing.T) {
	position := ProviderObservationPosition{
		ConnectionID: "connection-1",
		ChunkSeq:     1,
		UnitIndex:    1,
		EventIndex:   1,
	}
	address := EntityAddress{
		Kind: EntityKindToolCall,
		Origin: EntityOrigin{
			Source:              EntityOriginProviderObservation,
			ProviderObservation: &position,
		},
	}
	fingerprint := "sha256:" + strings.Repeat("a", 64)
	base := ObservationJournalEntry{
		SchemaVersion: ObservationSchemaVersion,
		Position: ProviderUnitPosition{
			ConnectionID: position.ConnectionID,
			ChunkSeq:     position.ChunkSeq,
			UnitIndex:    position.UnitIndex,
		},
		UnitKind: ProviderInputUnitProtocolMessage,
		Observations: []JournalObservation{{
			Position:    position,
			Type:        "call.started",
			Fingerprint: fingerprint,
			Address:     address,
		}},
		Correlations: []CheckpointCommitCorrelation{{
			ID:                     "correlation-1",
			Kind:                   "call.status",
			Address:                address,
			ObservationPosition:    position,
			ObservationFingerprint: fingerprint,
			Expected:               "running",
		}},
	}
	tests := []struct {
		name   string
		mutate func(*ObservationJournalEntry)
	}{
		{
			name: "observation fingerprint",
			mutate: func(entry *ObservationJournalEntry) {
				entry.Observations[0].Fingerprint =
					"sha256:" + strings.Repeat("b", 64)
			},
		},
		{
			name: "correlation address",
			mutate: func(entry *ObservationJournalEntry) {
				entry.Correlations[0].Address.Kind =
					EntityKindInteraction
			},
		},
		{
			name: "correlation kind",
			mutate: func(entry *ObservationJournalEntry) {
				entry.Correlations[0].Kind = "turn.status"
			},
		},
		{
			name: "correlation expected",
			mutate: func(entry *ObservationJournalEntry) {
				entry.Correlations[0].Expected = "completed"
			},
		},
		{
			name: "correlation observation",
			mutate: func(entry *ObservationJournalEntry) {
				entry.Correlations[0].ObservationPosition.EventIndex = 2
			},
		},
		{
			name: "correlation fingerprint",
			mutate: func(entry *ObservationJournalEntry) {
				entry.Correlations[0].ObservationFingerprint =
					"sha256:" + strings.Repeat("b", 64)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			update := base
			update.Observations = append(
				[]JournalObservation(nil),
				base.Observations...,
			)
			update.Correlations = append(
				[]CheckpointCommitCorrelation(nil),
				base.Correlations...,
			)
			test.mutate(&update)
			if _, err := mergeObservationJournalEntry(base, update); err == nil {
				t.Fatal("journal identity conflict was accepted")
			}
		})
	}
}

func TestMergeObservationJournalEntryConfirmsMonotonically(t *testing.T) {
	position := ProviderObservationPosition{
		ConnectionID: "connection-1",
		ChunkSeq:     1,
		UnitIndex:    1,
		EventIndex:   1,
	}
	address := EntityAddress{
		Kind: EntityKindTurn,
		Origin: EntityOrigin{
			Source:                EntityOriginActivityEvent,
			ActivityEventSequence: 1,
		},
	}
	fingerprint := "sha256:" + strings.Repeat("a", 64)
	base := ObservationJournalEntry{
		SchemaVersion: ObservationSchemaVersion,
		Position: ProviderUnitPosition{
			ConnectionID: "connection-1", ChunkSeq: 1, UnitIndex: 1,
		},
		UnitKind: ProviderInputUnitProtocolMessage,
		Correlations: []CheckpointCommitCorrelation{{
			ID: "correlation-1", Kind: "turn.status", Address: address,
			ObservationPosition: position, ObservationFingerprint: fingerprint,
			Expected: "completed",
		}},
	}
	update := base
	update.Correlations = append(
		[]CheckpointCommitCorrelation(nil),
		base.Correlations...,
	)
	update.Correlations[0].Confirmed = true
	update.Correlations[0].TransactionID = "transaction-1"
	merged, err := mergeObservationJournalEntry(base, update)
	if err != nil {
		t.Fatal(err)
	}
	if !merged.Correlations[0].Confirmed ||
		merged.Correlations[0].TransactionID != "transaction-1" {
		t.Fatalf("merged correlation = %#v", merged.Correlations[0])
	}
	conflict := update
	conflict.Correlations = append(
		[]CheckpointCommitCorrelation(nil),
		update.Correlations...,
	)
	conflict.Correlations[0].TransactionID = "transaction-2"
	if _, err := mergeObservationJournalEntry(merged, conflict); err == nil {
		t.Fatal("commit transaction conflict was accepted")
	}
}

func TestArtifactStorePublishesAndVerifiesSharedCassetteSchema(t *testing.T) {
	store := &Store{
		StateDir: t.TempDir(),
	}
	recording := Recording{
		ID: "recording-1", ScopeID: "workspace-1", AgentTargetID: "local:codex",
		ReplayPrerequisites: replayPrerequisitesForTest(),
		Name:                "2026-07-28T10:00:00.000Z",
		RootAgentSessionID:  "session-1", Mode: ScenarioModeCreateSession,
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
	if _, err := os.Stat(
		filepath.Join(artifact.Layout.StorageKey, ".recording"),
	); !os.IsNotExist(err) {
		t.Fatalf("candidate observation journal was published: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(artifact.Layout.StorageKey, CassetteManifestFile))
	if err != nil {
		t.Fatal(err)
	}
	var manifest CassetteManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.ID != "cassette-1" ||
		manifest.TotalBytes <= 0 {
		t.Fatalf("manifest = %#v", manifest)
	}
	for _, portablePath := range []string{
		CassetteManifestFile,
		ActivityEventsFile,
	} {
		contents, readErr := os.ReadFile(
			filepath.Join(artifact.Layout.StorageKey, portablePath),
		)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if strings.Contains(string(contents), `"scopeId"`) {
			t.Fatalf("%s contains capture Scope identity: %s", portablePath, contents)
		}
		if portablePath == ActivityEventsFile &&
			!strings.Contains(string(contents), recording.ScopeID) {
			t.Fatalf("activity user payload was rewritten: %s", contents)
		}
	}
	for _, removed := range []string{
		"scenario.json",
		"environment.json",
		"checkpoints.jsonl",
		"seed/state.jsonl",
		"expected/state.jsonl",
	} {
		if _, err := os.Stat(filepath.Join(artifact.Layout.StorageKey, removed)); !os.IsNotExist(err) {
			t.Fatalf("removed v4 artifact %q exists: %v", removed, err)
		}
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
	raw, err = os.ReadFile(filepath.Join(artifact.Layout.StorageKey, CassetteManifestFile))
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
		filepath.Join(artifact.Layout.StorageKey, ProviderFramesFile),
		[]byte("corrupt"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Resolve(context.Background(), artifact.Cassette); err == nil {
		t.Fatal("corrupt cassette was accepted")
	}
}

func TestArtifactStoreImportsAndVerifiesPortableCassetteDirectory(t *testing.T) {
	sourceStore := &Store{StateDir: t.TempDir()}
	recording := Recording{
		ID: "recording-1", ScopeID: "workspace-1", AgentTargetID: "local:codex",
		ReplayPrerequisites: replayPrerequisitesForTest(),
		Name:                "portable cassette",
		RootAgentSessionID:  "session-1", Mode: ScenarioModeCreateSession,
	}
	completeArtifactCandidate(t, sourceStore, recording)
	source, err := sourceStore.Publish(context.Background(), recording, "cassette-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	destinationStore := &Store{StateDir: t.TempDir()}
	imported, err := destinationStore.Import(context.Background(), source.Layout.StorageKey)
	if err != nil {
		t.Fatal(err)
	}
	if imported.Cassette.ID != "cassette-1" ||
		imported.Cassette.Name != "portable cassette" ||
		imported.Layout.StorageKey == source.Layout.StorageKey {
		t.Fatalf("imported = %#v", imported)
	}
	if _, err := os.Stat(source.Layout.StorageKey); err != nil {
		t.Fatalf("source cassette was changed: %v", err)
	}
	if _, err := destinationStore.Import(context.Background(), source.Layout.StorageKey); !errors.Is(err, ErrCassetteAlreadyExists) {
		t.Fatalf("duplicate import error = %v", err)
	}
}

func TestArtifactStoreRejectsUnrelatedFile(t *testing.T) {
	store := &Store{
		StateDir: t.TempDir(),
	}
	recording := Recording{
		ID: "recording-1", ScopeID: "workspace-1", AgentTargetID: "local:codex",
		ReplayPrerequisites: replayPrerequisitesForTest(),
		Name:                "2026-07-28T10:00:00.000Z",
		RootAgentSessionID:  "session-1", Mode: ScenarioModeCreateSession,
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

func TestArtifactStoreResolveIgnoresFinderMetadataOnly(t *testing.T) {
	store := &Store{
		StateDir: t.TempDir(),
	}
	recording := Recording{
		ID: "recording-1", ScopeID: "workspace-1", AgentTargetID: "local:codex",
		ReplayPrerequisites: replayPrerequisitesForTest(),
		Name:                "2026-07-28T10:00:00.000Z",
		RootAgentSessionID:  "session-1", Mode: ScenarioModeCreateSession,
	}
	completeArtifactCandidate(t, store, recording)
	artifact, err := store.Publish(context.Background(), recording, "cassette-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(artifact.Layout.StorageKey, ".DS_Store"),
		[]byte("finder metadata"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Resolve(context.Background(), artifact.Cassette); err != nil {
		t.Fatalf("Resolve with Finder metadata: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(artifact.Layout.StorageKey, "desktop.log"),
		[]byte("unrelated"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Resolve(context.Background(), artifact.Cassette); err == nil ||
		!strings.Contains(err.Error(), "inventory mismatch") {
		t.Fatalf("Resolve with unrelated file error = %v", err)
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
	recording := Recording{ID: "recording-1", ScopeID: "workspace-1"}
	layout, err := store.Prepare(context.Background(), recording)
	if err != nil {
		t.Fatal(err)
	}
	recording.ArtifactKey = layout.StorageKey
	if err := store.AppendActivityEvent(context.Background(), recording, ActivityEvent{
		SchemaVersion: CassetteSchemaVersion, Sequence: 1,
		Kind: ActivityEventKindIntent, Type: "submit/requested",
		EventID: "event-1", ScopeID: "workspace-1", OccurredAtMS: 1,
		Payload: map[string]any{"content": []map[string]any{{
			"type": "image", "path": asset, "mimeType": "image/png",
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(layout.StorageKey, ActivityEventsFile))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), asset) ||
		!strings.Contains(string(raw), `"data":"aW1hZ2UgYnl0ZXM="`) {
		t.Fatalf("event = %s", raw)
	}
}

func TestArtifactStoreExportsGeneratedImageBlob(t *testing.T) {
	stateDirectory := t.TempDir()
	recordingDirectory := t.TempDir()
	relativePath := "generated_images/call-1/image.png"
	source := filepath.Join(
		stateDirectory,
		"agent",
		"runs",
		"session-1",
		"codex-home",
		filepath.FromSlash(relativePath),
	)
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	imageBytes := []byte("generated image bytes")
	if err := os.WriteFile(source, imageBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(
		filepath.Join(recordingDirectory, "blobs", "sha256"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(recordingDirectory, "blobs", "manifest.json"),
		[]byte(`{"schemaVersion":1,"blobs":[]}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(recordingDirectory, "expected-state.json")
	state := map[string]any{
		"agent": map[string]any{
			"sessions": []any{map[string]any{
				"id":            "session-1",
				"agentTargetId": "local:codex",
				"provider":      "codex",
				"messages": []any{map[string]any{
					"payload": map[string]any{
						"output": map[string]any{
							"savedPath": PortableReplayHomeToken + "/" + relativePath,
							"savedPaths": []any{
								PortableReplayHomeToken + "/" + relativePath,
							},
							"imageMimeType": "image/png",
						},
					},
				}},
			}},
		},
	}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := (&Store{StateDir: stateDirectory}).exportFixtureBlobs(
		statePath,
		recordingDirectory,
	); err != nil {
		t.Fatal(err)
	}
	manifest, err := readBlobManifest(
		filepath.Join(recordingDirectory, "blobs", "manifest.json"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Blobs) != 1 ||
		manifest.Blobs[0].Kind != BlobKindAgentGeneratedImage ||
		manifest.Blobs[0].RelativePath != relativePath {
		t.Fatalf("generated image blob manifest = %#v", manifest)
	}
	exported, err := os.ReadFile(filepath.Join(
		recordingDirectory,
		"blobs",
		"sha256",
		manifest.Blobs[0].SHA256,
	))
	if err != nil {
		t.Fatal(err)
	}
	if string(exported) != string(imageBytes) {
		t.Fatalf("exported generated image = %q", exported)
	}
}

func TestArtifactStoreMakesActivationContentAssetsPortable(t *testing.T) {
	stateDir := t.TempDir()
	asset := filepath.Join(stateDir, "agent-prompt-assets", "workspace-1", "image.png")
	if err := os.MkdirAll(filepath.Dir(asset), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(asset, []byte("activation image"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &Store{StateDir: stateDir}
	for _, field := range []string{"content", "runtimeContent", "initialContent"} {
		event, err := store.portableActivityEvent(ActivityEvent{
			Type: "session/activate",
			Payload: map[string]any{field: []map[string]any{{
				"type": "image", "path": asset, "mimeType": "image/png",
			}}},
		})
		if err != nil {
			t.Fatalf("%s: %v", field, err)
		}
		raw, err := json.Marshal(event.Payload)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), asset) ||
			!strings.Contains(string(raw), `"data":"YWN0aXZhdGlvbiBpbWFnZQ=="`) {
			t.Fatalf("%s event = %s", field, raw)
		}
	}
}

func TestProviderTapePublicationAuditRejectsResidualSensitiveField(t *testing.T) {
	store := &Store{StateDir: t.TempDir()}
	recording := Recording{
		ID: "recording-1", ScopeID: "workspace-1", AgentTargetID: "local:codex",
		Name:               "2026-07-28T10:00:00.000Z",
		RootAgentSessionID: "session-1", Mode: ScenarioModeCreateSession,
		RecordingAtUnixMS: 1, StoppedAtUnixMS: 2,
	}
	layout := completeArtifactCandidate(t, store, recording)
	data := base64.StdEncoding.EncodeToString([]byte(
		`{"id":1,"result":{"account":{"email":"private@example.com"}}}` + "\n",
	))
	frame := `{"connectionId":"connection-1","globalSeq":1,"chunkSeq":1,"kind":"stdout","data":"` +
		data + `"}` + "\n"
	if err := os.WriteFile(
		filepath.Join(layout.ProviderTapeKey, "frames.jsonl"),
		[]byte(frame),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	_, err := readProviderConnectionIDs(layout.StorageKey)
	if err == nil || !strings.Contains(err.Error(), "sensitive field $.result.account.email") {
		t.Fatalf("readProviderConnectionIDs() error = %v, want sensitive Provider field rejection", err)
	}
	if strings.Contains(err.Error(), "private@example.com") {
		t.Fatalf("Provider tape audit exposed the rejected value: %v", err)
	}
}

func TestArtifactStoreProjectsSessionCreatePathsAtRecordingBoundary(t *testing.T) {
	store := &Store{StateDir: t.TempDir()}
	recording := Recording{ID: "recording-1", ScopeID: "workspace-1"}
	layout, err := store.Prepare(context.Background(), recording)
	if err != nil {
		t.Fatal(err)
	}
	recording.ArtifactKey = layout.StorageKey
	recordedCWD := filepath.Join(string(filepath.Separator), "Users", "developer", "project")
	if err := store.AppendActivityEvent(context.Background(), recording, ActivityEvent{
		SchemaVersion: CassetteSchemaVersion,
		Sequence:      1,
		Kind:          ActivityEventKindDirectStimulus,
		Type:          "session.create",
		EventID:       "event-1",
		ScopeID:       recording.ScopeID,
		OccurredAtMS:  1,
		Payload: map[string]any{
			"cwd":           recordedCWD,
			"displayPrompt": "keep " + recordedCWD + " in user text",
			"railPlacement": map[string]any{
				"projectPath": filepath.Join(recordedCWD, "packages", "agent"),
			},
		},
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(layout.StorageKey, ActivityEventsFile))
	if err != nil {
		t.Fatal(err)
	}
	contents := string(raw)
	if strings.Contains(contents, `"cwd":"`+recordedCWD+`"`) ||
		!strings.Contains(contents, `"cwd":"${REPLAY_CWD}"`) ||
		!strings.Contains(contents, `"projectPath":"${REPLAY_CWD}/packages/agent"`) {
		t.Fatalf("session.create paths were not projected: %s", contents)
	}
	var stored ActivityEvent
	if err := json.Unmarshal(bytes.TrimSpace(raw), &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Payload["displayPrompt"] != "keep "+recordedCWD+" in user text" {
		t.Fatalf("user-authored text was rewritten: %s", contents)
	}
}

func TestArtifactStoreProjectsEngineActivationPathsAtRecordingBoundary(t *testing.T) {
	recordedCWD := filepath.Join(string(filepath.Separator), "Users", "developer", "project")
	for _, eventType := range []string{"activation/requested", "session/activate"} {
		event, err := (&Store{}).portableActivityEvent(ActivityEvent{
			Type: eventType,
			Payload: map[string]any{
				"cwd": recordedCWD,
				"railPlacement": map[string]any{
					"kind":        "project",
					"projectPath": filepath.Join(recordedCWD, "packages", "agent"),
					"sectionKey":  "project:" + filepath.Join(recordedCWD, "packages", "agent"),
				},
				"railSectionKey": "project:" + filepath.Join(recordedCWD, "packages", "agent"),
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		if event.Payload["cwd"] != PortableReplayCWDToken {
			t.Fatalf("%s cwd = %v", eventType, event.Payload["cwd"])
		}
		rail, _ := event.Payload["railPlacement"].(map[string]any)
		if rail["projectPath"] != PortableReplayCWDToken+"/packages/agent" {
			t.Fatalf("%s railPlacement = %#v", eventType, rail)
		}
		portableSectionKey := "project:" + PortableReplayCWDToken + "/packages/agent"
		if rail["sectionKey"] != portableSectionKey {
			t.Fatalf("%s railPlacement.sectionKey = %v", eventType, rail["sectionKey"])
		}
		if event.Payload["railSectionKey"] != portableSectionKey {
			t.Fatalf("%s railSectionKey = %v", eventType, event.Payload["railSectionKey"])
		}
	}
}

func TestArtifactStoreKeepsConversationsSectionKeyPortable(t *testing.T) {
	event, err := (&Store{}).portableActivityEvent(ActivityEvent{
		Type: "activation/requested",
		Payload: map[string]any{
			"cwd": "",
			"railPlacement": map[string]any{
				"kind":       "conversations",
				"sectionKey": "conversations",
			},
			"railSectionKey": "conversations",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	rail, _ := event.Payload["railPlacement"].(map[string]any)
	if rail["sectionKey"] != "conversations" ||
		event.Payload["railSectionKey"] != "conversations" {
		t.Fatalf("conversations section keys were rewritten: %#v", event.Payload)
	}
}

func TestPortableActivityValidationRejectsResidualAbsoluteActivationPath(t *testing.T) {
	for _, eventType := range []string{
		"activation/requested",
		"session.create",
		"session/activate",
	} {
		for _, payload := range []map[string]any{
			{"cwd": "/Users/developer/project"},
			{"railPlacement": map[string]any{"projectPath": "/Users/developer/project"}},
			{"railPlacement": map[string]any{"sectionKey": "project:/Users/developer/project"}},
			{"railSectionKey": "project:/Users/developer/project"},
		} {
			err := validatePortableActivityEvents([]ActivityEvent{{
				Sequence: 1,
				Type:     eventType,
				Payload:  payload,
			}})
			if err == nil || !strings.Contains(err.Error(), "absolute recording path") {
				t.Fatalf("%s validation error = %v", eventType, err)
			}
		}
	}
}
