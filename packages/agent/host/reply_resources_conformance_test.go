package agenthost_test

import (
	"context"
	"errors"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/host/conformance"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type replyResourceConformanceDriver struct {
	host  *agenthost.Host
	store *replyResourceConformanceStore
}

type replyResourceConformanceStore struct {
	activeTurnID string
	phase        string
	resources    []storesqlite.ReplyResource
}

func (d *replyResourceConformanceDriver) Reset(_ context.Context, fixture conformance.Fixture) error {
	d.store = &replyResourceConformanceStore{}
	if fixture.Session != nil {
		d.store.activeTurnID = fixture.Session.ActiveTurnID
	}
	if fixture.Turn != nil {
		d.store.phase = fixture.Turn.Phase
	}
	d.host = agenthost.New(agenthost.Config{ReplyResources: d.store})
	return nil
}

func (d *replyResourceConformanceDriver) AttachReplyResource(ctx context.Context, ref agenthost.SessionRef, input agenthost.AttachReplyResourceInput) (agenthost.AttachReplyResourceResult, error) {
	return d.host.AttachReplyResource(ctx, ref, input)
}

func (d *replyResourceConformanceDriver) ListTurnReplyResources(ctx context.Context, ref agenthost.SessionRef, turnID string) ([]storesqlite.ReplyResource, error) {
	return d.host.ListTurnReplyResources(ctx, ref, turnID)
}

func (s *replyResourceConformanceStore) AttachReplyResourceToActiveTurn(_ context.Context, input storesqlite.AttachReplyResourceInput) (storesqlite.ReplyResource, bool, error) {
	if s.activeTurnID == "" || s.activeTurnID != input.TurnID || s.phase == storesqlite.TurnPhaseSettled {
		return storesqlite.ReplyResource{}, false, storesqlite.ErrNoActiveTurn
	}
	for _, resource := range s.resources {
		if resource.DedupeKey == input.DedupeKey {
			return resource, false, nil
		}
	}
	resource := storesqlite.ReplyResource{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, TurnID: s.activeTurnID,
		ResourceID: input.ResourceID, DedupeKey: input.DedupeKey, Kind: input.Kind, SourceRef: input.SourceRef,
		ContentHash: input.ContentHash, DisplayName: input.DisplayName, MediaType: input.MediaType,
		SizeBytes: input.SizeBytes, CreatedAtUnixMS: input.CreatedAtUnixMS,
	}
	s.resources = append(s.resources, resource)
	return resource, true, nil
}

func (s *replyResourceConformanceStore) ListTurnReplyResources(_ context.Context, workspaceID, sessionID, turnID string) ([]storesqlite.ReplyResource, error) {
	if workspaceID == "" || sessionID == "" || turnID == "" {
		return nil, errors.New("invalid query")
	}
	return append([]storesqlite.ReplyResource(nil), s.resources...), nil
}

func TestReplyResourceConformance(t *testing.T) {
	for _, scenario := range conformance.ReplyResourceScenarios() {
		t.Run(scenario.Name, func(t *testing.T) {
			if err := conformance.RunReplyResource(t.Context(), &replyResourceConformanceDriver{}, scenario); err != nil {
				t.Fatal(err)
			}
		})
	}
}
