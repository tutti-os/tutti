package sessionreplay

import (
	"errors"
	"strings"
)

type RecordingTransition struct {
	Status       RecordingStatus
	AtUnixMS     int64
	CassetteID   string
	ErrorCode    string
	ErrorMessage string
}

func IsRecordingActive(status RecordingStatus) bool {
	switch status {
	case RecordingStatusPreparing,
		RecordingStatusReady,
		RecordingStatusRecording,
		RecordingStatusFinalizing:
		return true
	default:
		return false
	}
}

func TransitionRecording(recording *Recording, transition RecordingTransition) error {
	if recording == nil || transition.AtUnixMS <= 0 {
		return ErrInvalidState
	}
	if recording.Status == transition.Status {
		return nil
	}
	if !recordingTransitionAllowed(recording.Status, transition.Status) {
		return ErrInvalidState
	}
	switch transition.Status {
	case RecordingStatusRecording:
		if strings.TrimSpace(recording.RootAgentSessionID) == "" {
			return ErrInvalidState
		}
		if recording.RecordingAtUnixMS == 0 {
			recording.RecordingAtUnixMS = transition.AtUnixMS
		}
	case RecordingStatusFinalizing:
		if recording.Status != RecordingStatusRecording {
			return ErrInvalidState
		}
		if recording.StoppedAtUnixMS == 0 {
			recording.StoppedAtUnixMS = transition.AtUnixMS
		}
	case RecordingStatusComplete:
		if strings.TrimSpace(transition.CassetteID) == "" {
			return ErrInvalidState
		}
		recording.CassetteID = strings.TrimSpace(transition.CassetteID)
	case RecordingStatusFailed, RecordingStatusIncomplete:
		if strings.TrimSpace(transition.ErrorCode) == "" ||
			strings.TrimSpace(transition.ErrorMessage) == "" {
			return ErrInvalidState
		}
		recording.ErrorCode = strings.TrimSpace(transition.ErrorCode)
		recording.ErrorMessage = transition.ErrorMessage
	}
	if transition.Status != RecordingStatusFailed &&
		transition.Status != RecordingStatusIncomplete {
		recording.ErrorCode = ""
		recording.ErrorMessage = ""
	}
	recording.Status = transition.Status
	recording.UpdatedAtUnixMS = transition.AtUnixMS
	return nil
}

func recordingTransitionAllowed(from, to RecordingStatus) bool {
	switch from {
	case RecordingStatusPreparing:
		return to == RecordingStatusReady ||
			to == RecordingStatusRecording ||
			to == RecordingStatusFailed ||
			to == RecordingStatusCanceled ||
			to == RecordingStatusIncomplete
	case RecordingStatusReady:
		return to == RecordingStatusRecording ||
			to == RecordingStatusFailed ||
			to == RecordingStatusCanceled ||
			to == RecordingStatusIncomplete
	case RecordingStatusRecording:
		return to == RecordingStatusFinalizing ||
			to == RecordingStatusFailed ||
			to == RecordingStatusCanceled ||
			to == RecordingStatusIncomplete
	case RecordingStatusFinalizing:
		return to == RecordingStatusComplete ||
			to == RecordingStatusFailed ||
			to == RecordingStatusCanceled ||
			to == RecordingStatusIncomplete
	default:
		return false
	}
}

type ReplayRunTransition struct {
	Status       ReplayRunStatus
	AtUnixMS     int64
	Checkpoint   int64
	ErrorCode    string
	ErrorMessage string
}

func TransitionReplayRun(run *ReplayRun, transition ReplayRunTransition) error {
	if run == nil ||
		run.Checkpoint < 0 ||
		transition.AtUnixMS <= 0 ||
		transition.Checkpoint < run.Checkpoint {
		return ErrInvalidState
	}
	if run.Status == ReplayRunStatusStarting && transition.Checkpoint != 0 {
		return ErrInvalidState
	}
	if run.Status == transition.Status {
		if run.Status == ReplayRunStatusRunning &&
			transition.Checkpoint > run.Checkpoint {
			run.Checkpoint = transition.Checkpoint
			run.UpdatedAtUnixMS = transition.AtUnixMS
			return nil
		}
		if transition.Checkpoint == run.Checkpoint {
			return nil
		}
		return ErrInvalidState
	}
	if !replayRunTransitionAllowed(run.Status, transition.Status) {
		return ErrInvalidState
	}
	if transition.Status == ReplayRunStatusFailed &&
		(strings.TrimSpace(transition.ErrorCode) == "" ||
			strings.TrimSpace(transition.ErrorMessage) == "") {
		return errors.Join(ErrInvalidState, errors.New("failed replay run requires an error"))
	}
	switch transition.Status {
	case ReplayRunStatusRunning:
		if run.StartedAtUnixMS == 0 {
			run.StartedAtUnixMS = transition.AtUnixMS
		}
	case ReplayRunStatusComplete, ReplayRunStatusFailed, ReplayRunStatusCanceled:
		run.CompletedAtUnixMS = transition.AtUnixMS
	}
	if transition.Status == ReplayRunStatusFailed {
		run.ErrorCode = strings.TrimSpace(transition.ErrorCode)
		run.ErrorMessage = transition.ErrorMessage
	} else {
		run.ErrorCode = ""
		run.ErrorMessage = ""
	}
	run.Status = transition.Status
	run.Checkpoint = transition.Checkpoint
	run.UpdatedAtUnixMS = transition.AtUnixMS
	return nil
}

func replayRunTransitionAllowed(from, to ReplayRunStatus) bool {
	switch from {
	case ReplayRunStatusStarting:
		return to == ReplayRunStatusRunning ||
			to == ReplayRunStatusFailed ||
			to == ReplayRunStatusCanceled
	case ReplayRunStatusRunning:
		return to == ReplayRunStatusComplete ||
			to == ReplayRunStatusFailed ||
			to == ReplayRunStatusCanceled
	default:
		return false
	}
}
