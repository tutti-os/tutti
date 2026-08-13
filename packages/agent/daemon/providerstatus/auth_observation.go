package providerstatus

import "strings"

// AuthObservationStatus is the provider-neutral authentication state exposed
// after local and remote evidence have been reduced. Local credential material
// is deliberately distinct from a remotely authenticated request.
type AuthObservationStatus string

const (
	AuthObservationUnknown       AuthObservationStatus = "unknown"
	AuthObservationConfigured    AuthObservationStatus = "configured"
	AuthObservationAuthenticated AuthObservationStatus = "authenticated"
	AuthObservationRequired      AuthObservationStatus = "required"
	AuthObservationProbeFailed   AuthObservationStatus = "probe-failed"
)

// AuthEvidenceAuthority records whether an observation came from local
// configuration or from a provider request. Remote evidence always outranks
// local status commands and credential files until the consumer resets the
// observation at an explicit identity, credential, or runtime boundary.
type AuthEvidenceAuthority string

const (
	AuthEvidenceAuthorityNone   AuthEvidenceAuthority = "none"
	AuthEvidenceAuthorityLocal  AuthEvidenceAuthority = "local"
	AuthEvidenceAuthorityRemote AuthEvidenceAuthority = "remote"
)

type AuthEvidenceKind string

const (
	AuthEvidenceLocalStatus       AuthEvidenceKind = "local-status"
	AuthEvidenceLocalCredential   AuthEvidenceKind = "local-credential"
	AuthEvidenceRemoteSuccess     AuthEvidenceKind = "remote-success"
	AuthEvidenceRemoteAuthFailure AuthEvidenceKind = "remote-auth-failure"
	AuthEvidenceProbeFailure      AuthEvidenceKind = "probe-failure"
)

const (
	AuthReasonAuthRequired         = "auth_required"
	AuthReasonSessionExpired       = "session_expired"
	AuthReasonCredentialConfigured = "credential-configured"
	AuthReasonLocalSessionDetected = "local-session-detected"
	AuthReasonProbeFailed          = "probe-failed"
)

// AuthEvidence is one provider-neutral fact. Provider adapters own how the
// fact is collected; this package owns how competing facts are reduced.
type AuthEvidence struct {
	Kind         AuthEvidenceKind
	AccountLabel string
	AuthMethod   string
	Reason       string
}

// AuthObservation is the reduced result consumed by product status and UI
// layers. Authority is retained so a weaker local probe cannot resurrect a
// remotely revoked or expired session.
type AuthObservation struct {
	Status       AuthObservationStatus
	Authority    AuthEvidenceAuthority
	AccountLabel string
	AuthMethod   string
	Reason       string
}

// LocalAuthEvidence converts an existing provider auth-status result into a
// weak local fact. Even when a CLI says "logged in", that only proves locally
// configured material unless the adapter separately reports remote success.
func LocalAuthEvidence(info AuthInfo) AuthEvidence {
	evidence := AuthEvidence{
		Kind:         AuthEvidenceLocalStatus,
		AccountLabel: strings.TrimSpace(info.AccountLabel),
		AuthMethod:   strings.TrimSpace(info.AuthMethod),
	}
	switch info.Status {
	case AuthAuthenticated:
		evidence.Reason = AuthReasonLocalSessionDetected
	case AuthConfigured:
		evidence.Kind = AuthEvidenceLocalCredential
		evidence.Reason = AuthReasonCredentialConfigured
	case AuthRequired:
		evidence.Reason = AuthReasonAuthRequired
	}
	return evidence
}

// AuthInfoFromObservation projects the richer evidence-reduction result onto
// the compact provider-status contract consumed by daemon hosts and UIs.
func AuthInfoFromObservation(observation AuthObservation) AuthInfo {
	info := AuthInfo{
		AccountLabel: strings.TrimSpace(observation.AccountLabel),
		AuthMethod:   strings.TrimSpace(observation.AuthMethod),
	}
	switch observation.Status {
	case AuthObservationConfigured:
		info.Status = AuthConfigured
	case AuthObservationAuthenticated:
		info.Status = AuthAuthenticated
	case AuthObservationRequired:
		info.Status = AuthRequired
	default:
		info.Status = AuthUnknown
	}
	return info
}

// ReduceAuthEvidence applies one fact to the current observation. Consumers
// reset current to its zero value when the account, credential generation, or
// runtime epoch changes.
func ReduceAuthEvidence(current AuthObservation, evidence AuthEvidence) AuthObservation {
	evidence.AccountLabel = strings.TrimSpace(evidence.AccountLabel)
	evidence.AuthMethod = strings.TrimSpace(evidence.AuthMethod)
	evidence.Reason = strings.TrimSpace(evidence.Reason)

	switch evidence.Kind {
	case AuthEvidenceRemoteSuccess:
		return AuthObservation{
			Status: AuthObservationAuthenticated, Authority: AuthEvidenceAuthorityRemote,
			AccountLabel: evidence.AccountLabel, AuthMethod: evidence.AuthMethod,
		}
	case AuthEvidenceRemoteAuthFailure:
		reason := evidence.Reason
		if reason != AuthReasonSessionExpired {
			reason = AuthReasonAuthRequired
		}
		return AuthObservation{
			Status: AuthObservationRequired, Authority: AuthEvidenceAuthorityRemote,
			Reason: reason,
		}
	case AuthEvidenceProbeFailure:
		if IsSettledAuthObservation(current) {
			return current
		}
		reason := evidence.Reason
		if reason == "" {
			reason = AuthReasonProbeFailed
		}
		return AuthObservation{Status: AuthObservationProbeFailed, Reason: reason}
	case AuthEvidenceLocalCredential:
		if current.Authority == AuthEvidenceAuthorityRemote {
			return current
		}
		return AuthObservation{
			Status: AuthObservationConfigured, Authority: AuthEvidenceAuthorityLocal,
			AccountLabel: evidence.AccountLabel, AuthMethod: evidence.AuthMethod,
			Reason: AuthReasonCredentialConfigured,
		}
	case AuthEvidenceLocalStatus:
		if current.Authority == AuthEvidenceAuthorityRemote {
			return current
		}
		switch evidence.Reason {
		case AuthReasonAuthRequired, AuthReasonSessionExpired:
			return AuthObservation{
				Status: AuthObservationRequired, Authority: AuthEvidenceAuthorityLocal,
				Reason: evidence.Reason,
			}
		case AuthReasonLocalSessionDetected:
			return AuthObservation{
				Status: AuthObservationConfigured, Authority: AuthEvidenceAuthorityLocal,
				AccountLabel: evidence.AccountLabel, AuthMethod: evidence.AuthMethod,
				Reason: AuthReasonLocalSessionDetected,
			}
		default:
			return AuthObservation{Status: AuthObservationUnknown}
		}
	default:
		return current
	}
}

func IsSettledAuthObservation(observation AuthObservation) bool {
	switch observation.Status {
	case AuthObservationConfigured,
		AuthObservationAuthenticated,
		AuthObservationRequired,
		AuthObservationProbeFailed:
		return true
	default:
		return false
	}
}
