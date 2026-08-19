package host

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

const (
	InstallationFailureCodePhysicallyAbsent  = "connector_installation_absent"
	InstallationFailureCodePhysicallyInvalid = "connector_installation_invalid"
)

// InstallationCalibrationConnectorKeys returns the durable projection keys
// eligible for a physical installation probe, including failed projections
// that may have been repaired outside the daemon.
func (application *Application) InstallationCalibrationConnectorKeys(ctx context.Context) ([]string, error) {
	if application == nil || application.config.ReleaseInstallations == nil {
		return nil, nil
	}
	snapshot, err := application.config.Repository.Snapshot(ctx)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(snapshot.Connectors))
	for _, connector := range snapshot.Connectors {
		if installationCalibrationCandidate(connector) {
			keys = append(keys, connector.Key)
		}
	}
	return keys, nil
}

// CalibrateInstalledConnectorsForScope compares the repository projection
// with the physical installation manager. Inspection is release- and
// receipt-based: Connector-owned commands are never executed. Indeterminate
// observations preserve the current projection.
func (application *Application) CalibrateInstalledConnectorsForScope(
	ctx context.Context,
	scope OperationScope,
) error {
	if application == nil || application.config.ReleaseInstallations == nil {
		return nil
	}
	snapshot, err := application.config.Repository.Snapshot(ctx)
	if err != nil {
		return err
	}
	var calibrationErrors []error
	for _, connector := range snapshot.Connectors {
		if !installationCalibrationCandidate(connector) {
			continue
		}
		if err := application.CalibrateInstalledConnectorForScope(ctx, scope, connector.Key); err != nil {
			calibrationErrors = append(calibrationErrors, err)
		}
	}
	return errors.Join(calibrationErrors...)
}

// CalibrateInstalledConnectorForScope probes one Connector independently so a
// slow or indeterminate installation manager cannot delay runtime recovery for
// unrelated Connectors.
func (application *Application) CalibrateInstalledConnectorForScope(
	ctx context.Context,
	scope OperationScope,
	connectorKey string,
) error {
	if application == nil || application.config.ReleaseInstallations == nil {
		return nil
	}
	connector, err := application.config.Repository.Connector(ctx, strings.TrimSpace(connectorKey))
	if err != nil {
		return err
	}
	if !installationCalibrationCandidate(connector) {
		return nil
	}
	release, err := application.installedReleaseEvidence(ctx, connector)
	if err != nil {
		return fmt.Errorf("calibrate connector %s: %w", connector.Key, err)
	}
	operationID := "inspect/" + application.config.BootEpoch + "/" + connector.Key
	observation, err := application.config.ReleaseInstallations.InspectReleaseInstallation(ctx, InspectReleaseInstallationRequest{
		OperationID: operationID,
		Scope:       scope,
		Generation:  HostGeneration{BootEpoch: application.config.BootEpoch, Generation: nextGeneration(connector.Revision)},
		Release:     release,
	})
	if err != nil {
		return fmt.Errorf("calibrate connector %s installation: %w", connector.Key, err)
	}
	if observation.ConnectorKey != connector.Key || observation.ReleaseDigest != release.ReleaseDigest ||
		!validReleaseInstallationObservation(observation.State) {
		return fmt.Errorf("calibrate connector %s: installation manager returned a mismatched observation", connector.Key)
	}
	if observation.State == ReleaseInstallationIndeterminate {
		return nil
	}
	if err := application.applyInstallationObservation(ctx, connector.Key, operationID, release.ReleaseDigest, observation.State); err != nil {
		return fmt.Errorf("calibrate connector %s projection: %w", connector.Key, err)
	}
	return nil
}

// PrepareInstalledRuntimeForScope preserves the per-Connector safety order:
// physical installation truth is calibrated before runtime Desired is made
// eligible for convergence. Callers may execute this workflow concurrently
// across Connector keys without introducing a global startup barrier.
func (application *Application) PrepareInstalledRuntimeForScope(
	ctx context.Context,
	scope OperationScope,
	connectorKey string,
) (bool, error) {
	calibrationErr := application.CalibrateInstalledConnectorForScope(ctx, scope, connectorKey)
	connector, err := application.config.Repository.Connector(ctx, strings.TrimSpace(connectorKey))
	if err != nil {
		return false, errors.Join(calibrationErr, err)
	}
	if connector.Installation.State != InstallationStateInstalled {
		return false, calibrationErr
	}
	_, planErr := application.PlanRuntimeAfterFence(ctx, scope, connector.Key)
	return planErr == nil, errors.Join(calibrationErr, planErr)
}

func installationCalibrationCandidate(connector Connector) bool {
	if strings.TrimSpace(connector.Installation.InstalledReleaseDigest) == "" {
		return false
	}
	return connector.Installation.State == InstallationStateInstalled ||
		(connector.Installation.State == InstallationStateFailed &&
			(connector.Installation.FailureCode == InstallationFailureCodePhysicallyAbsent ||
				connector.Installation.FailureCode == InstallationFailureCodePhysicallyInvalid))
}

func validReleaseInstallationObservation(state ReleaseInstallationObservationState) bool {
	switch state {
	case ReleaseInstallationPresent, ReleaseInstallationAbsent, ReleaseInstallationInvalid, ReleaseInstallationIndeterminate:
		return true
	default:
		return false
	}
}

func (application *Application) applyInstallationObservation(
	ctx context.Context,
	connectorKey, operationID, releaseDigest string,
	state ReleaseInstallationObservationState,
) error {
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		connector, err := tx.Connector(connectorKey)
		if err != nil {
			return err
		}
		if connector.Installation.InstalledReleaseDigest != releaseDigest || !installationCalibrationCandidate(connector) {
			return nil
		}
		next := connector.Installation
		switch state {
		case ReleaseInstallationPresent:
			if next.State == InstallationStateInstalled {
				return nil
			}
			next.State, next.FailureCode = InstallationStateInstalled, ""
		case ReleaseInstallationAbsent:
			if next.State == InstallationStateFailed && next.FailureCode == InstallationFailureCodePhysicallyAbsent {
				return nil
			}
			next.State, next.FailureCode = InstallationStateFailed, InstallationFailureCodePhysicallyAbsent
		case ReleaseInstallationInvalid:
			if next.State == InstallationStateFailed && next.FailureCode == InstallationFailureCodePhysicallyInvalid {
				return nil
			}
			next.State, next.FailureCode = InstallationStateFailed, InstallationFailureCodePhysicallyInvalid
		case ReleaseInstallationIndeterminate:
			return nil
		default:
			return errors.New("installation observation state is invalid")
		}
		revision := tx.AdvanceRevision()
		connector.Installation = next
		connector.Revision = revision
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{ConnectorKey: connector.Key,
			OperationID: operationID, Revision: revision})
	})
}
