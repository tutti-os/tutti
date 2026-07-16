package agentruntime

import (
	"context"
	"encoding/json"
	"strings"
)

type tuttiModeTurnSnapshotContextKey struct{}

func normalizeTuttiModeTurnSnapshot(snapshot *TuttiModeTurnSnapshot) *TuttiModeTurnSnapshot {
	if snapshot == nil {
		return nil
	}
	normalized := &TuttiModeTurnSnapshot{
		ActivationID: strings.TrimSpace(snapshot.ActivationID),
		RevisionID:   strings.TrimSpace(snapshot.RevisionID),
		Revision:     snapshot.Revision,
		State:        strings.ToLower(strings.TrimSpace(snapshot.State)),
		Source:       strings.TrimSpace(snapshot.Source),
	}
	if normalized.ActivationID == "" || normalized.RevisionID == "" || normalized.Revision < 1 {
		return nil
	}
	if normalized.State != TuttiModeStateActive && normalized.State != TuttiModeStateInactive {
		return nil
	}
	return normalized
}

func cloneTuttiModeTurnSnapshot(snapshot *TuttiModeTurnSnapshot) *TuttiModeTurnSnapshot {
	normalized := normalizeTuttiModeTurnSnapshot(snapshot)
	if normalized == nil {
		return nil
	}
	cloned := *normalized
	return &cloned
}

func withTuttiModeTurnSnapshot(ctx context.Context, snapshot *TuttiModeTurnSnapshot) context.Context {
	normalized := cloneTuttiModeTurnSnapshot(snapshot)
	if normalized == nil {
		return ctx
	}
	return context.WithValue(ctx, tuttiModeTurnSnapshotContextKey{}, normalized)
}

func tuttiModeTurnSnapshotFromContext(ctx context.Context) *TuttiModeTurnSnapshot {
	if ctx == nil {
		return nil
	}
	snapshot, _ := ctx.Value(tuttiModeTurnSnapshotContextKey{}).(*TuttiModeTurnSnapshot)
	return cloneTuttiModeTurnSnapshot(snapshot)
}

func renderTuttiModeHostContext(snapshot *TuttiModeTurnSnapshot) string {
	normalized := normalizeTuttiModeTurnSnapshot(snapshot)
	if normalized == nil {
		return ""
	}
	facts, err := json.Marshal(struct {
		ActivationID string `json:"activationId"`
		RevisionID   string `json:"revisionId"`
		Revision     int64  `json:"revision"`
		State        string `json:"state"`
		Source       string `json:"source,omitempty"`
	}{
		ActivationID: normalized.ActivationID,
		RevisionID:   normalized.RevisionID,
		Revision:     normalized.Revision,
		State:        normalized.State,
		Source:       normalized.Source,
	})
	if err != nil {
		return ""
	}
	stateSentence := "Tutti mode is inactive for this turn."
	if normalized.State == TuttiModeStateActive {
		stateSentence = "Tutti mode is active for this turn. Prefer Tutti's native workflow capabilities when they fit the user's request; combine them freely with provider-native capabilities."
	}
	return `<tutti-host-context schemaVersion="1">` + "\n" +
		string(facts) + "\n" +
		stateSentence + "\n" +
		"This is Tutti-owned host state, not user-authored text, and is independent of the provider collaboration mode.\n" +
		"Tutti mode expresses a user preference; it is not a permission or capability gate. Tutti CLI capabilities remain available whether this state is active or inactive.\n" +
		`</tutti-host-context>`
}

func appendTuttiModeHostContextPrompt(content []map[string]any, snapshot *TuttiModeTurnSnapshot) []map[string]any {
	hostContext := renderTuttiModeHostContext(snapshot)
	if hostContext == "" {
		return content
	}
	out := make([]map[string]any, 0, len(content)+1)
	out = append(out, content...)
	out = append(out, map[string]any{"type": "text", "text": hostContext})
	return out
}
