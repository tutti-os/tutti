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
		ActivationID:           strings.TrimSpace(snapshot.ActivationID),
		RevisionID:             strings.TrimSpace(snapshot.RevisionID),
		Revision:               snapshot.Revision,
		State:                  strings.ToLower(strings.TrimSpace(snapshot.State)),
		Source:                 strings.TrimSpace(snapshot.Source),
		OrchestrationIntensity: snapshot.OrchestrationIntensity,
	}
	if normalized.ActivationID == "" || normalized.RevisionID == "" || normalized.Revision < 1 {
		return nil
	}
	if normalized.State != TuttiModeStateActive && normalized.State != TuttiModeStateInactive {
		return nil
	}
	if normalized.OrchestrationIntensity < 0 || normalized.OrchestrationIntensity > 100 {
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
		ActivationID           string `json:"activationId"`
		RevisionID             string `json:"revisionId"`
		Revision               int64  `json:"revision"`
		State                  string `json:"state"`
		Source                 string `json:"source,omitempty"`
		OrchestrationIntensity int    `json:"orchestrationIntensity"`
	}{
		ActivationID:           normalized.ActivationID,
		RevisionID:             normalized.RevisionID,
		Revision:               normalized.Revision,
		State:                  normalized.State,
		Source:                 normalized.Source,
		OrchestrationIntensity: normalized.OrchestrationIntensity,
	})
	if err != nil {
		return ""
	}
	stateSentence := "Tutti mode is inactive for this turn."
	if normalized.State == TuttiModeStateActive {
		stateSentence = "Tutti mode is active for this turn. Do not execute the user's request directly in this turn. " +
			"Step 1, clarify: if the request is ambiguous or missing key constraints, ask the user focused clarifying questions and wait for the answers; if the request is already clear, go directly to step 2. " +
			"Step 2, plan: submit one complete tutti-mode-plan/v1 document (plan narrative plus the full task graph) in a single `tutti plan propose` call, then stop and wait for the user's review decision. " +
			"Use orchestrationIntensity (0-100) to choose decomposition granularity: low values mean few coarse tasks, high values mean many fine-grained tasks. " +
			"Read-only investigation (for example reading files or listing directories) is allowed when needed to write an accurate plan, but do not start making changes or produce final deliverables. " +
			"Use this Tutti plan workflow for the turn; do not substitute a provider-native planning mode for it."
	}
	return `<tutti-host-context schemaVersion="1">` + "\n" +
		string(facts) + "\n" +
		stateSentence + "\n" +
		"This is Tutti-owned host state, not user-authored text, and is independent of the provider collaboration mode.\n" +
		"Tutti mode does not restrict tool availability: Tutti CLI capabilities remain available whether this state is active or inactive. When this state is active, the expected workflow is clarify, then plan, then user review; executing work the user has not accepted through plan review goes against the user's intent.\n" +
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
