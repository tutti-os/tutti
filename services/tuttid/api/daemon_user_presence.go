package api

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	userpresenceservice "github.com/tutti-os/tutti/services/tuttid/service/userpresence"
)

type UserPresenceService interface {
	VisitRoom(context.Context, userpresenceservice.VisitRoomInput) (userpresenceservice.RoomPresenceSnapshot, error)
	RoomSnapshot(string) userpresenceservice.RoomPresenceSnapshot
	SetForeground(bool)
}

func (api DaemonAPI) PutAccountUserPresenceCurrentRoom(ctx context.Context, request tuttigenerated.PutAccountUserPresenceCurrentRoomRequestObject) (tuttigenerated.PutAccountUserPresenceCurrentRoomResponseObject, error) {
	if api.UserPresenceService == nil {
		return tuttigenerated.PutAccountUserPresenceCurrentRoom503JSONResponse{
			ServiceUnavailableErrorJSONResponse: userPresenceUnavailable("user_presence_service_unavailable", nil),
		}, nil
	}
	if request.Body == nil || strings.TrimSpace(request.Body.RoomId) == "" {
		return tuttigenerated.PutAccountUserPresenceCurrentRoom400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("user_presence_room_required")),
		}, nil
	}
	members := make([]userpresenceservice.RoomMemberProjection, 0, len(request.Body.Members))
	for _, member := range request.Body.Members {
		members = append(members, userpresenceservice.RoomMemberProjection{
			UserID: member.UserId, MembershipActive: member.MembershipActive,
			AccountPresenceCapable: member.AccountPresenceCapable,
		})
	}
	snapshot, err := api.UserPresenceService.VisitRoom(ctx, userpresenceservice.VisitRoomInput{
		RoomID: request.Body.RoomId, Members: members,
	})
	if err != nil {
		if errors.Is(err, userpresenceservice.ErrPresenceUserLimit) || errors.Is(err, userpresenceservice.ErrPresenceFrameLimit) {
			return tuttigenerated.PutAccountUserPresenceCurrentRoom400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("user_presence_interest_quota_exceeded", apierrors.WithCause(err))),
			}, nil
		}
		// The page is allowed to open with a non-authoritative offline
		// projection. AccountRealtime retains the desired set for reconnection,
		// so transport/snapshot failures are diagnostics rather than API failure.
		slog.Warn("user presence current room remains degraded", "event", "tutti.user_presence.degraded", "roomId", request.Body.RoomId, "error", err)
	}
	return tuttigenerated.PutAccountUserPresenceCurrentRoom200JSONResponse(generatedRoomPresence(snapshot)), nil
}

func (api DaemonAPI) GetAccountUserPresenceRoom(_ context.Context, request tuttigenerated.GetAccountUserPresenceRoomRequestObject) (tuttigenerated.GetAccountUserPresenceRoomResponseObject, error) {
	if api.UserPresenceService == nil {
		return tuttigenerated.GetAccountUserPresenceRoom503JSONResponse{
			ServiceUnavailableErrorJSONResponse: userPresenceUnavailable("user_presence_service_unavailable", nil),
		}, nil
	}
	return tuttigenerated.GetAccountUserPresenceRoom200JSONResponse(generatedRoomPresence(api.UserPresenceService.RoomSnapshot(request.RoomID))), nil
}

func (api DaemonAPI) PutAccountUserPresenceForeground(_ context.Context, request tuttigenerated.PutAccountUserPresenceForegroundRequestObject) (tuttigenerated.PutAccountUserPresenceForegroundResponseObject, error) {
	if api.UserPresenceService == nil {
		return tuttigenerated.PutAccountUserPresenceForeground503JSONResponse{
			ServiceUnavailableErrorJSONResponse: userPresenceUnavailable("user_presence_service_unavailable", nil),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.PutAccountUserPresenceForeground400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	api.UserPresenceService.SetForeground(request.Body.Foreground)
	return tuttigenerated.PutAccountUserPresenceForeground204Response{}, nil
}

func generatedRoomPresence(snapshot userpresenceservice.RoomPresenceSnapshot) tuttigenerated.AccountUserPresenceRoomResponse {
	result := tuttigenerated.AccountUserPresenceRoomResponse{
		RoomId: snapshot.RoomID, Members: make([]tuttigenerated.AccountUserPresenceUser, 0, len(snapshot.Members)),
	}
	for _, member := range snapshot.Members {
		generated := tuttigenerated.AccountUserPresenceUser{
			UserId: member.UserID, Status: tuttigenerated.AccountUserPresenceUserStatus(member.Status),
			Availability:  tuttigenerated.AccountUserPresenceUserAvailability(member.Availability),
			Authoritative: member.Authoritative, AuthorityGeneration: member.AuthorityGeneration,
			PresenceRevision: member.PresenceRevision,
		}
		if !member.ObservedAt.IsZero() {
			observedAt := member.ObservedAt
			generated.ObservedAt = &observedAt
		}
		result.Members = append(result.Members, generated)
	}
	return result
}

func userPresenceUnavailable(reason string, err error) tuttigenerated.ServiceUnavailableErrorJSONResponse {
	options := []apierrors.Option{}
	if err != nil {
		options = append(options, apierrors.WithCause(err))
	}
	return serviceUnavailableError(apierrors.ServiceUnavailable(reason, options...))
}
