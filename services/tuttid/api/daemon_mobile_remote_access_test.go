package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
	mobileremoteservice "github.com/tutti-os/tutti/services/tuttid/service/mobileremote"
)

type stubMobileRemoteService struct {
	start mobileremoteservice.StartPairingResult
	err   error
}

func (s stubMobileRemoteService) StartPairing(context.Context) (mobileremoteservice.StartPairingResult, error) {
	return s.start, s.err
}

func (s stubMobileRemoteService) GetChallenge(context.Context, string) (mobileremotebiz.PairingChallenge, error) {
	return s.start.Challenge, s.err
}

func (s stubMobileRemoteService) ConfirmPairing(context.Context, string) (mobileremoteservice.ConfirmChallengeResult, error) {
	return mobileremoteservice.ConfirmChallengeResult{}, s.err
}

func (s stubMobileRemoteService) ListPairings(context.Context) ([]mobileremotebiz.DevicePairing, error) {
	return []mobileremotebiz.DevicePairing{}, s.err
}

func (s stubMobileRemoteService) RevokePairing(context.Context, string) (mobileremotebiz.DevicePairing, error) {
	return mobileremotebiz.DevicePairing{}, s.err
}

func TestStartMobileRemotePairingRouteReturnsDaemonOwnedQRPayload(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		MobileRemoteService: stubMobileRemoteService{
			start: mobileremoteservice.StartPairingResult{
				Challenge: mobileremotebiz.PairingChallenge{
					ChallengeID: "challenge-1", TargetUserDeviceID: "desktop-device",
					State: "pending", Revision: 1,
					ExpiresAt: time.Date(2026, 7, 23, 10, 5, 0, 0, time.UTC),
				},
				QRPayload: `{"version":1,"challengeId":"challenge-1","secret":"pair-secret"}`,
			},
		},
	}))

	request := httptest.NewRequest(http.MethodPost, "/v1/mobile-remote-access/pairing-challenges", nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status %d: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"qrPayload"`) ||
		!strings.Contains(recorder.Body.String(), `challenge-1`) {
		t.Fatalf("unexpected response body: %s", recorder.Body.String())
	}
}

func TestMobileRemotePairingRouteRejectsWrongMethod(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))

	request := httptest.NewRequest(http.MethodGet, "/v1/mobile-remote-access/pairing-challenges", nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("unexpected status %d: %s", recorder.Code, recorder.Body.String())
	}
}
