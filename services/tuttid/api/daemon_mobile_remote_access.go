package api

import (
	"context"
	"errors"
	"math"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	mobileremotebiz "github.com/tutti-os/tutti/services/tuttid/biz/mobileremote"
	mobileremoteservice "github.com/tutti-os/tutti/services/tuttid/service/mobileremote"
)

type MobileRemoteService interface {
	StartPairing(context.Context) (mobileremoteservice.StartPairingResult, error)
	GetChallenge(context.Context, string) (mobileremotebiz.PairingChallenge, error)
	ConfirmPairing(context.Context, string) (mobileremoteservice.ConfirmChallengeResult, error)
	ListPairings(context.Context) ([]mobileremotebiz.DevicePairing, error)
	RevokePairing(context.Context, string) (mobileremotebiz.DevicePairing, error)
}

func (api DaemonAPI) StartMobileRemotePairing(ctx context.Context, _ tuttigenerated.StartMobileRemotePairingRequestObject) (tuttigenerated.StartMobileRemotePairingResponseObject, error) {
	if api.MobileRemoteService == nil {
		return startMobileRemoteUnavailable("mobile remote access service is unavailable", nil), nil
	}
	started, err := api.MobileRemoteService.StartPairing(ctx)
	if err != nil {
		return startMobileRemoteUnavailable("mobile remote pairing could not be started", err), nil
	}
	challenge, err := generatedMobileRemoteChallenge(started.Challenge)
	if err != nil {
		return startMobileRemoteUnavailable("mobile remote pairing challenge is invalid", err), nil
	}
	return tuttigenerated.StartMobileRemotePairing200JSONResponse{
		Challenge: challenge,
		QrPayload: started.QRPayload,
	}, nil
}

func (api DaemonAPI) GetMobileRemotePairingChallenge(ctx context.Context, request tuttigenerated.GetMobileRemotePairingChallengeRequestObject) (tuttigenerated.GetMobileRemotePairingChallengeResponseObject, error) {
	if strings.TrimSpace(request.ChallengeID) == "" {
		return tuttigenerated.GetMobileRemotePairingChallenge400JSONResponse{
			InvalidRequestErrorJSONResponse: mobileRemoteInvalidRequest("mobile_remote_challenge_id_required"),
		}, nil
	}
	if api.MobileRemoteService == nil {
		return getMobileRemoteUnavailable("mobile remote access service is unavailable", nil), nil
	}
	challenge, err := api.MobileRemoteService.GetChallenge(ctx, request.ChallengeID)
	if err != nil {
		return getMobileRemoteUnavailable("mobile remote pairing challenge could not be read", err), nil
	}
	generated, err := generatedMobileRemoteChallenge(challenge)
	if err != nil {
		return getMobileRemoteUnavailable("mobile remote pairing challenge is invalid", err), nil
	}
	return tuttigenerated.GetMobileRemotePairingChallenge200JSONResponse{Challenge: generated}, nil
}

func (api DaemonAPI) ConfirmMobileRemotePairing(ctx context.Context, request tuttigenerated.ConfirmMobileRemotePairingRequestObject) (tuttigenerated.ConfirmMobileRemotePairingResponseObject, error) {
	if strings.TrimSpace(request.ChallengeID) == "" {
		return tuttigenerated.ConfirmMobileRemotePairing400JSONResponse{
			InvalidRequestErrorJSONResponse: mobileRemoteInvalidRequest("mobile_remote_challenge_id_required"),
		}, nil
	}
	if api.MobileRemoteService == nil {
		return confirmMobileRemoteUnavailable("mobile remote access service is unavailable", nil), nil
	}
	confirmed, err := api.MobileRemoteService.ConfirmPairing(ctx, request.ChallengeID)
	if err != nil {
		return confirmMobileRemoteUnavailable("mobile remote pairing could not be confirmed", err), nil
	}
	challenge, err := generatedMobileRemoteChallenge(confirmed.Challenge)
	if err != nil {
		return confirmMobileRemoteUnavailable("mobile remote pairing challenge is invalid", err), nil
	}
	pairing, err := generatedMobileRemotePairing(confirmed.Pairing)
	if err != nil {
		return confirmMobileRemoteUnavailable("mobile remote pairing is invalid", err), nil
	}
	return tuttigenerated.ConfirmMobileRemotePairing200JSONResponse{
		Challenge: challenge,
		Pairing:   pairing,
	}, nil
}

func (api DaemonAPI) ListMobileRemotePairings(ctx context.Context, _ tuttigenerated.ListMobileRemotePairingsRequestObject) (tuttigenerated.ListMobileRemotePairingsResponseObject, error) {
	if api.MobileRemoteService == nil {
		return listMobileRemoteUnavailable("mobile remote access service is unavailable", nil), nil
	}
	pairings, err := api.MobileRemoteService.ListPairings(ctx)
	if err != nil {
		return listMobileRemoteUnavailable("mobile remote pairings could not be read", err), nil
	}
	response := make([]tuttigenerated.MobileRemoteDevicePairing, 0, len(pairings))
	for _, pairing := range pairings {
		generated, err := generatedMobileRemotePairing(pairing)
		if err != nil {
			return listMobileRemoteUnavailable("mobile remote pairing is invalid", err), nil
		}
		response = append(response, generated)
	}
	return tuttigenerated.ListMobileRemotePairings200JSONResponse{Pairings: response}, nil
}

func (api DaemonAPI) RevokeMobileRemotePairing(ctx context.Context, request tuttigenerated.RevokeMobileRemotePairingRequestObject) (tuttigenerated.RevokeMobileRemotePairingResponseObject, error) {
	if strings.TrimSpace(request.PairingID) == "" {
		return tuttigenerated.RevokeMobileRemotePairing400JSONResponse{
			InvalidRequestErrorJSONResponse: mobileRemoteInvalidRequest("mobile_remote_pairing_id_required"),
		}, nil
	}
	if api.MobileRemoteService == nil {
		return revokeMobileRemoteUnavailable("mobile remote access service is unavailable", nil), nil
	}
	pairing, err := api.MobileRemoteService.RevokePairing(ctx, request.PairingID)
	if err != nil {
		return revokeMobileRemoteUnavailable("mobile remote pairing could not be revoked", err), nil
	}
	generated, err := generatedMobileRemotePairing(pairing)
	if err != nil {
		return revokeMobileRemoteUnavailable("mobile remote pairing is invalid", err), nil
	}
	return tuttigenerated.RevokeMobileRemotePairing200JSONResponse{Pairing: generated}, nil
}

func generatedMobileRemoteChallenge(challenge mobileremotebiz.PairingChallenge) (tuttigenerated.MobileRemotePairingChallenge, error) {
	revision, err := mobileRemoteRevision(challenge.Revision)
	if err != nil {
		return tuttigenerated.MobileRemotePairingChallenge{}, err
	}
	return tuttigenerated.MobileRemotePairingChallenge{
		ChallengeId:            challenge.ChallengeID,
		TargetUserDeviceId:     challenge.TargetUserDeviceID,
		ControllerUserDeviceId: mobileRemoteOptionalString(challenge.ControllerUserDeviceID),
		State:                  challenge.State,
		PairingId:              mobileRemoteOptionalString(challenge.PairingID),
		Revision:               revision,
		ExpiresAt:              challenge.ExpiresAt,
	}, nil
}

func generatedMobileRemotePairing(pairing mobileremotebiz.DevicePairing) (tuttigenerated.MobileRemoteDevicePairing, error) {
	revision, err := mobileRemoteRevision(pairing.Revision)
	if err != nil {
		return tuttigenerated.MobileRemoteDevicePairing{}, err
	}
	return tuttigenerated.MobileRemoteDevicePairing{
		PairingId:              pairing.PairingID,
		ControllerUserDeviceId: pairing.ControllerUserDeviceID,
		TargetUserDeviceId:     pairing.TargetUserDeviceID,
		State:                  pairing.State,
		Revision:               revision,
		ConfirmedAt:            pairing.ConfirmedAt,
		RevokedAt:              pairing.RevokedAt,
	}, nil
}

func mobileRemoteRevision(revision uint64) (int64, error) {
	if revision > math.MaxInt64 {
		return 0, errors.New("mobile remote revision exceeds local API range")
	}
	return int64(revision), nil
}

func mobileRemoteOptionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func mobileRemoteInvalidRequest(reason string) tuttigenerated.InvalidRequestErrorJSONResponse {
	return invalidRequestError(apierrors.InvalidRequest(reason))
}

func mobileRemoteUnavailable(reason string, cause error) tuttigenerated.ServiceUnavailableErrorJSONResponse {
	options := []apierrors.Option{apierrors.WithDeveloperMessage(reason)}
	if cause != nil {
		options = append(options, apierrors.WithCause(cause))
	}
	return serviceUnavailableError(apierrors.ServiceUnavailable("mobile_remote_access_unavailable", options...))
}

func startMobileRemoteUnavailable(reason string, cause error) tuttigenerated.StartMobileRemotePairing503JSONResponse {
	return tuttigenerated.StartMobileRemotePairing503JSONResponse{
		ServiceUnavailableErrorJSONResponse: mobileRemoteUnavailable(reason, cause),
	}
}

func getMobileRemoteUnavailable(reason string, cause error) tuttigenerated.GetMobileRemotePairingChallenge503JSONResponse {
	return tuttigenerated.GetMobileRemotePairingChallenge503JSONResponse{
		ServiceUnavailableErrorJSONResponse: mobileRemoteUnavailable(reason, cause),
	}
}

func confirmMobileRemoteUnavailable(reason string, cause error) tuttigenerated.ConfirmMobileRemotePairing503JSONResponse {
	return tuttigenerated.ConfirmMobileRemotePairing503JSONResponse{
		ServiceUnavailableErrorJSONResponse: mobileRemoteUnavailable(reason, cause),
	}
}

func listMobileRemoteUnavailable(reason string, cause error) tuttigenerated.ListMobileRemotePairings503JSONResponse {
	return tuttigenerated.ListMobileRemotePairings503JSONResponse{
		ServiceUnavailableErrorJSONResponse: mobileRemoteUnavailable(reason, cause),
	}
}

func revokeMobileRemoteUnavailable(reason string, cause error) tuttigenerated.RevokeMobileRemotePairing503JSONResponse {
	return tuttigenerated.RevokeMobileRemotePairing503JSONResponse{
		ServiceUnavailableErrorJSONResponse: mobileRemoteUnavailable(reason, cause),
	}
}
