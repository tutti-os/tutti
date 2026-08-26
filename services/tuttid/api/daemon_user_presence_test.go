package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	userpresenceservice "github.com/tutti-os/tutti/services/tuttid/service/userpresence"
)

type userPresenceServiceStub struct {
	visited userpresenceservice.VisitRoomInput
}

func (stub *userPresenceServiceStub) VisitRoom(_ context.Context, input userpresenceservice.VisitRoomInput) (userpresenceservice.RoomPresenceSnapshot, error) {
	stub.visited = input
	return userpresenceservice.RoomPresenceSnapshot{RoomID: input.RoomID, Members: []userpresenceservice.PresenceView{{
		UserID: "user-2", Status: userpresenceservice.StatusOnline,
		Availability: userpresenceservice.AvailabilityReady, Authoritative: true,
		AuthorityGeneration: "authority-1", PresenceRevision: "4",
	}}}, nil
}

func (*userPresenceServiceStub) RoomSnapshot(roomID string) userpresenceservice.RoomPresenceSnapshot {
	return userpresenceservice.RoomPresenceSnapshot{RoomID: roomID}
}

func (*userPresenceServiceStub) SetForeground(bool) {}

func TestAccountUserPresenceCurrentRoomRoute(t *testing.T) {
	service := &userPresenceServiceStub{}
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{UserPresenceService: service}))
	request := httptest.NewRequest(http.MethodPut, "/v1/account/user-presence/current-room", strings.NewReader(`{
      "roomId":"room-1",
      "members":[{"userId":"user-2","membershipActive":true,"accountPresenceCapable":true}]
    }`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var body tuttigenerated.AccountUserPresenceRoomResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if service.visited.RoomID != "room-1" || len(service.visited.Members) != 1 || len(body.Members) != 1 ||
		body.Members[0].Status != tuttigenerated.ONLINE || !body.Members[0].Authoritative {
		t.Fatalf("visit=%#v response=%#v", service.visited, body)
	}
}
