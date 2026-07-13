package agent

import (
	"context"
)

type ActivePeer struct {
	Session      Session
	SelfRelation string
}

type ActivePeers struct {
	Agents         []ActivePeer
	SelfKnown      bool
	MayIncludeSelf bool
	Warning        string
}

func (s *Service) ListActivePeers(ctx context.Context, workspaceID string) (ActivePeers, error) {
	sessions, err := s.List(ctx, workspaceID)
	if err != nil {
		return ActivePeers{}, err
	}
	peers := make([]ActivePeer, 0)
	for _, session := range sessions {
		if session.ActiveTurnID == "" && session.ActiveTurn == nil {
			continue
		}
		peers = append(peers, ActivePeer{
			Session:      cloneSession(session),
			SelfRelation: "unknown",
		})
	}
	return ActivePeers{
		Agents:         peers,
		SelfKnown:      false,
		MayIncludeSelf: true,
		Warning:        "SELF_IDENTITY_UNAVAILABLE",
	}, nil
}
