package agentextension

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

const (
	AccountUsageSchemaVersion        = "tutti.agent.account-usage.v2"
	accountUsageProbeSchemaVersionV1 = "tutti.agent.account-usage.v1"
	accountUsageOutputLimit          = 256 << 10
	accountUsageProbeTimeout         = 45 * time.Second
)

var ErrInvalidAccountUsageTarget = errors.New("invalid account usage agent target")

type AccountUsageResult struct {
	SchemaVersion    string
	AgentTargetID    string
	Provider         string
	Outcome          string
	CapturedAtUnixMS int64
	BillingMode      string
	QuotaState       string
	Quotas           []AccountUsageQuota
	ErrorCode        string
}

type AccountUsageQuota struct {
	QuotaType        string
	PercentRemaining float64
	AmountRemaining  *float64
	AmountLimit      *float64
	AmountUnit       string
	ResetsAtUnixMS   *int64
	ModelName        string
}

type AccountUsageService struct {
	Manager *Manager
	Targets AgentTargetLookup
	Now     func() time.Time
	run     func(context.Context, string, string, []string, *agentruntime.ExecutableIdentity, *agentruntime.ExecutableIdentity, int) ([]byte, error)
}

func (service AccountUsageService) Probe(ctx context.Context, rawTargetID string) (AccountUsageResult, error) {
	targetID := strings.TrimSpace(rawTargetID)
	if targetID == "" {
		return AccountUsageResult{}, ErrInvalidAccountUsageTarget
	}
	if service.Manager == nil || service.Targets == nil {
		return AccountUsageResult{}, errors.New("account usage service is not configured")
	}
	return service.Manager.accountUsageProbeResults().load(ctx, targetID, func() (AccountUsageResult, error) {
		probeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), accountUsageProbeTimeout)
		defer cancel()
		return service.probe(probeCtx, targetID)
	})
}

func (service AccountUsageService) probe(ctx context.Context, targetID string) (AccountUsageResult, error) {
	target, err := service.Targets.GetAgentTarget(ctx, targetID)
	if err != nil {
		return AccountUsageResult{}, err
	}
	target, err = agenttargetbiz.NormalizeTarget(target)
	if err != nil || target.ID != targetID {
		return AccountUsageResult{}, ErrInvalidAccountUsageTarget
	}
	capturedAtUnixMS := service.now().UnixMilli()
	base := AccountUsageResult{
		SchemaVersion: AccountUsageSchemaVersion, AgentTargetID: target.ID,
		Provider: target.Provider, CapturedAtUnixMS: capturedAtUnixMS,
	}
	if !target.Enabled {
		base.Outcome = "unsupported"
		return base, nil
	}
	launchRef, err := agenttargetbiz.RuntimeProviderTargetRef(target)
	if err != nil || launchRef["kind"] != agenttargetbiz.LaunchRefTypeAgentExtension {
		base.Outcome = "unsupported"
		return base, nil
	}
	installationID, _ := launchRef["extensionInstallationId"].(string)
	installation, err := service.Manager.loadInstallationByID(strings.TrimSpace(installationID))
	if err != nil || installation.Provider != target.Provider {
		base.Outcome = "error"
		base.ErrorCode = "runtime_unavailable"
		return base, nil
	}
	profile, err := loadAccountUsageProfile(installation)
	if err != nil {
		base.Outcome = "error"
		base.ErrorCode = "parse_failed"
		return base, nil
	}
	if profile == nil {
		base.Outcome = "unsupported"
		return base, nil
	}
	accountUsageBinding, err := service.accountUsageRuntimeBinding(ctx, installation, target.Provider, profile)
	if err != nil || accountUsageBinding == nil || accountUsageBinding.NodePath == "" || accountUsageBinding.ScriptPath == "" ||
		accountUsageBinding.NodeIdentity == nil || accountUsageBinding.ScriptIdentity == nil {
		base.Outcome = "error"
		base.ErrorCode = "runtime_unavailable"
		return base, nil
	}
	if err := ctx.Err(); err != nil {
		return AccountUsageResult{}, err
	}
	probeCtx, cancel := context.WithTimeout(ctx, accountUsageBinding.Timeout)
	defer cancel()
	run := service.run
	if run == nil {
		run = service.Manager.accountUsageNodeScriptRunner().Run
	}
	output, err := run(
		probeCtx,
		accountUsageBinding.NodePath,
		accountUsageBinding.ScriptPath,
		accountUsageBinding.Args,
		accountUsageBinding.NodeIdentity,
		accountUsageBinding.ScriptIdentity,
		accountUsageOutputLimit,
	)
	if err != nil {
		base.Outcome = "error"
		if errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
			base.ErrorCode = "timeout"
		} else {
			base.ErrorCode = "execution_failed"
		}
		return base, nil
	}
	payload, err := decodeAccountUsagePayload(output)
	if err != nil {
		base.Outcome = "error"
		base.ErrorCode = "parse_failed"
		return base, nil
	}
	base.Outcome = payload.Outcome
	base.CapturedAtUnixMS = payload.CapturedAtUnixMS
	base.BillingMode = payload.BillingMode
	base.QuotaState = payload.QuotaState
	base.Quotas = payload.Quotas
	base.ErrorCode = payload.ErrorCode
	return base, nil
}

func (service AccountUsageService) accountUsageRuntimeBinding(
	ctx context.Context,
	installation Installation,
	provider string,
	profile *AccountUsageProfile,
) (*AccountUsageRuntimeBinding, error) {
	if localExecutable := service.Manager.localAccountUsageExecutable(installation); localExecutable != "" {
		return service.Manager.resolvedLocalAccountUsageRuntimeBindingContext(ctx, localExecutable, profile)
	}
	binding, err := service.Manager.resolveInstalledAccountUsageRuntimeBindingContext(ctx, installation, profile)
	if err != nil {
		return nil, err
	}
	if installation.Provider != provider {
		return nil, errors.New("account usage runtime binding identity is invalid")
	}
	return binding, nil
}

func (service AccountUsageService) now() time.Time {
	if service.Now != nil {
		return service.Now().UTC()
	}
	return time.Now().UTC()
}

type accountUsagePayload struct {
	SchemaVersion    string          `json:"schemaVersion"`
	Outcome          string          `json:"outcome"`
	CapturedAtUnixMS *int64          `json:"capturedAtUnixMs"`
	BillingMode      string          `json:"billingMode,omitempty"`
	QuotaState       string          `json:"quotaState,omitempty"`
	Quotas           json.RawMessage `json:"quotas,omitempty"`
	ErrorCode        string          `json:"errorCode,omitempty"`
}

type accountUsageQuotaPayload struct {
	QuotaType        string   `json:"quotaType"`
	PercentRemaining *float64 `json:"percentRemaining"`
	AmountRemaining  *float64 `json:"amountRemaining,omitempty"`
	AmountLimit      *float64 `json:"amountLimit,omitempty"`
	AmountUnit       string   `json:"amountUnit,omitempty"`
	ResetsAtUnixMS   *int64   `json:"resetsAtUnixMs,omitempty"`
	ModelName        string   `json:"modelName,omitempty"`
}

func decodeAccountUsagePayload(output []byte) (AccountUsageResult, error) {
	var payload accountUsagePayload
	if err := decodeStrictJSON(output, &payload); err != nil {
		return AccountUsageResult{}, err
	}
	if (payload.SchemaVersion != accountUsageProbeSchemaVersionV1 && payload.SchemaVersion != AccountUsageSchemaVersion) || payload.CapturedAtUnixMS == nil || *payload.CapturedAtUnixMS < 0 {
		return AccountUsageResult{}, errors.New("account usage payload identity is invalid")
	}
	result := AccountUsageResult{
		SchemaVersion: AccountUsageSchemaVersion,
		Outcome:       payload.Outcome, CapturedAtUnixMS: *payload.CapturedAtUnixMS,
	}
	switch payload.Outcome {
	case "available":
		if payload.ErrorCode != "" || !accountUsageBillingMode(payload.BillingMode) || len(payload.Quotas) == 0 {
			return AccountUsageResult{}, errors.New("available account usage payload is invalid")
		}
		var quotas []accountUsageQuotaPayload
		if err := decodeStrictJSON(payload.Quotas, &quotas); err != nil || quotas == nil || len(quotas) > 64 {
			return AccountUsageResult{}, errors.New("account usage quotas are invalid")
		}
		result.BillingMode = payload.BillingMode
		if payload.SchemaVersion == accountUsageProbeSchemaVersionV1 {
			if payload.QuotaState != "" || (payload.BillingMode != "subscription" && payload.BillingMode != "api") {
				return AccountUsageResult{}, errors.New("v1 account usage payload is invalid")
			}
			if payload.BillingMode == "subscription" && len(quotas) == 0 {
				return AccountUsageResult{}, errors.New("subscription account usage requires quotas")
			}
			if payload.BillingMode == "api" && len(quotas) != 0 {
				return AccountUsageResult{}, errors.New("API billing must not project subscription quotas")
			}
			if payload.BillingMode == "api" {
				result.QuotaState = "not_applicable"
			} else {
				result.QuotaState = "complete"
			}
		} else {
			if !validAccountUsageQuotaState(payload.BillingMode, payload.QuotaState, len(quotas)) {
				return AccountUsageResult{}, errors.New("account usage quota state is invalid")
			}
			result.QuotaState = payload.QuotaState
		}
		for _, quota := range quotas {
			validated, err := validateAccountUsageQuota(quota)
			if err != nil {
				return AccountUsageResult{}, err
			}
			result.Quotas = append(result.Quotas, validated)
		}
	case "unsupported":
		if payload.BillingMode != "" || payload.QuotaState != "" || len(payload.Quotas) != 0 || payload.ErrorCode != "" {
			return AccountUsageResult{}, errors.New("unsupported account usage payload contains extra fields")
		}
	case "error":
		if payload.BillingMode != "" || payload.QuotaState != "" || len(payload.Quotas) != 0 || !accountUsageErrorCode(payload.ErrorCode) {
			return AccountUsageResult{}, errors.New("account usage error payload is invalid")
		}
		result.ErrorCode = payload.ErrorCode
	default:
		return AccountUsageResult{}, errors.New("account usage outcome is unsupported")
	}
	return result, nil
}

func validateAccountUsageQuota(payload accountUsageQuotaPayload) (AccountUsageQuota, error) {
	if !accountUsageQuotaType(payload.QuotaType) || payload.PercentRemaining == nil || math.IsNaN(*payload.PercentRemaining) || math.IsInf(*payload.PercentRemaining, 0) || *payload.PercentRemaining < 0 || *payload.PercentRemaining > 100 {
		return AccountUsageQuota{}, errors.New("account usage quota is invalid")
	}
	if payload.ResetsAtUnixMS != nil && *payload.ResetsAtUnixMS < 0 {
		return AccountUsageQuota{}, errors.New("account usage quota reset is invalid")
	}
	modelName := strings.TrimSpace(payload.ModelName)
	if (payload.QuotaType == "model" && modelName == "") || modelName != payload.ModelName || utf8.RuneCountInString(modelName) > 128 || strings.ContainsFunc(modelName, unicode.IsControl) {
		return AccountUsageQuota{}, errors.New("account usage quota model name is invalid")
	}
	if payload.QuotaType == "credits" {
		if !validAccountUsageAmount(payload.AmountRemaining) || !validAccountUsageAmount(payload.AmountLimit) || payload.AmountUnit != "credits" || *payload.AmountRemaining > *payload.AmountLimit {
			return AccountUsageQuota{}, errors.New("account usage credit amount is invalid")
		}
	} else if payload.AmountRemaining != nil || payload.AmountLimit != nil || payload.AmountUnit != "" {
		return AccountUsageQuota{}, errors.New("account usage amount is unsupported for quota type")
	}
	return AccountUsageQuota{
		QuotaType: payload.QuotaType, PercentRemaining: *payload.PercentRemaining,
		AmountRemaining: payload.AmountRemaining, AmountLimit: payload.AmountLimit,
		AmountUnit:     payload.AmountUnit,
		ResetsAtUnixMS: payload.ResetsAtUnixMS, ModelName: modelName,
	}, nil
}

func validAccountUsageAmount(value *float64) bool {
	return value != nil && !math.IsNaN(*value) && !math.IsInf(*value, 0) && *value >= 0
}

func accountUsageBillingMode(value string) bool {
	switch value {
	case "subscription", "api", "coding_plan", "provider_account":
		return true
	default:
		return false
	}
}

func validAccountUsageQuotaState(billingMode string, quotaState string, quotaCount int) bool {
	switch quotaState {
	case "complete":
		return billingMode != "api" && quotaCount > 0
	case "unavailable":
		return billingMode != "api" && quotaCount == 0
	case "not_applicable":
		return billingMode == "api" && quotaCount == 0
	default:
		return false
	}
}

func accountUsageQuotaType(value string) bool {
	switch value {
	case "session", "daily", "weekly", "monthly", "model", "credits", "cost":
		return true
	default:
		return false
	}
}

func accountUsageErrorCode(value string) bool {
	switch value {
	case "auth_required", "config_invalid", "execution_failed", "no_data", "parse_failed", "rate_limited", "runtime_unavailable", "session_expired", "timeout":
		return true
	default:
		return false
	}
}

func decodeStrictJSON(input []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("JSON payload contains trailing content")
	}
	return nil
}
