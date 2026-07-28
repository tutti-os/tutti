package agentruntime

import "testing"

func TestDuplicateAndBacktrackingAssistantSnapshotsDoNotLeakFullUpdates(t *testing.T) {
	t.Parallel()

	session := reportTestSession()
	normalizer := newACPTurnNormalizer()
	initial := normalizer.AppendAssistantChunk(session, "turn-1", "Hello world")
	if stream := ProjectActivityEventsToStreamEvents(session, initial); len(stream) != 1 ||
		stream[0].EventType != StreamEventMessageDelta {
		t.Fatalf("initial stream = %#v, want one message delta", stream)
	}

	for _, noOpSnapshot := range []string{"Hello world", "Hello"} {
		events := normalizer.AppendAssistantChunk(session, "turn-1", noOpSnapshot)
		if len(events) != 0 {
			t.Fatalf("snapshot %q emitted activity events = %#v", noOpSnapshot, events)
		}
		if stream := ProjectActivityEventsToStreamEvents(session, events); len(stream) != 0 {
			t.Fatalf("snapshot %q leaked stream events = %#v", noOpSnapshot, stream)
		}
	}
}
