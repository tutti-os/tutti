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
		release, evidenceErr := application.installedReleaseEvidence(ctx, connector)
		if evidenceErr != nil {
			calibrationErrors = append(calibrationErrors, fmt.Errorf("calibrate connector %s: %w", connector.Key, evidenceErr))
			continue
		}
		operationID := "inspect/" + application.config.BootEpoch + "/" + connector.Key
		observation, inspectErr := application.config.ReleaseInstallations.InspectReleaseInstallation(ctx, InspectReleaseInstallationRequest{
			OperationID: operationID,
			Scope:       scope,
			Generation:  HostGeneration{BootEpoch: application.config.BootEpoch, Generation: nextGeneration(connector.Revision)},
			Release:     release,
		})
		if inspectErr != nil {
			calibrationErrors = append(calibrationErrors, fmt.Errorf("calibrate connector %s installation: %w", connector.Key, inspectErr))
			continue
		}
		if observation.ConnectorKey != connector.Key || observation.ReleaseDigest != release.ReleaseDigest ||
			!validReleaseInstallationObservation(observation.State) {
			calibrationErrors = append(calibrationErrors, fmt.Errorf("calibrate connector %s: installation manager returned a mismatched observation", connector.Key))
			continue
		}
		if observation.State == ReleaseInstallationIndeterminate {
			continue
		}
		if err := application.applyInstallationObservation(ctx, connector.Key, operationID, release.ReleaseDigest, observation.State); err != nil {
			calibrationErrors = append(calibrationErrors, fmt.Errorf("calibrate connector %s projection: %w", connector.Key, err))
		}
	}
	return errors.Join(calibrationErrors...)
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
