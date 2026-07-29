import type { AgentGUISharedAgentAccess } from "./types.ts";

export type AgentGUISharedAgentUnavailableReason =
  | "owner_offline"
  | "share_concurrency_limit"
  | "share_cost_limit_exhausted"
  | "share_quota_exhausted";

export function normalizeAgentGUISharedAgentAccess(
  input: AgentGUISharedAgentAccess | null | undefined
): AgentGUISharedAgentAccess | null {
  if (!input) return null;
  const grantId = input.grantId.trim();
  const ownerUserId = input.ownerUserId.trim();
  if (!grantId || !ownerUserId) return null;
  const quota = input.quota
    ? {
        unit: input.quota.unit,
        remaining: normalizeNonNegativeNumber(input.quota.remaining),
        ...(input.quota.limit === undefined
          ? {}
          : { limit: normalizeNonNegativeNumber(input.quota.limit) }),
        ...(input.quota.resetAt?.trim()
          ? { resetAt: input.quota.resetAt.trim() }
          : {})
      }
    : null;
  const concurrency = input.concurrency
    ? {
        active: normalizeNonNegativeNumber(input.concurrency.active),
        limit: normalizeNonNegativeNumber(input.concurrency.limit)
      }
    : null;
  const costQuota = input.costQuota
    ? {
        currency: input.costQuota.currency.trim().toUpperCase(),
        remainingMicros: normalizeNonNegativeNumber(
          input.costQuota.remainingMicros
        ),
        ...(input.costQuota.limitMicros === undefined
          ? {}
          : {
              limitMicros: normalizeNonNegativeNumber(
                input.costQuota.limitMicros
              )
            })
      }
    : null;
  const allowedModels = normalizeAllowedModels(input.allowedModels);
  return {
    grantId,
    ownerUserId,
    ownerOnline: input.ownerOnline,
    auditRequired: input.auditRequired,
    ...(quota ? { quota } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(costQuota?.currency ? { costQuota } : {}),
    ...(allowedModels.length > 0 ? { allowedModels } : {}),
    ...(input.policyPermissions
      ? {
          policyPermissions: {
            consult: input.policyPermissions.consult === true,
            review: input.policyPermissions.review === true,
            delegate: input.policyPermissions.delegate === true,
            upgrade: input.policyPermissions.upgrade === true
          }
        }
      : {})
  };
}

export function agentGUISharedAgentUnavailableReason(
  input: AgentGUISharedAgentAccess | null | undefined
): AgentGUISharedAgentUnavailableReason | null {
  const access = normalizeAgentGUISharedAgentAccess(input);
  if (!access) return null;
  if (!access.ownerOnline) return "owner_offline";
  if (access.quota && access.quota.remaining <= 0) {
    return "share_quota_exhausted";
  }
  if (access.costQuota && access.costQuota.remainingMicros <= 0) {
    return "share_cost_limit_exhausted";
  }
  if (
    access.concurrency &&
    access.concurrency.limit > 0 &&
    access.concurrency.active >= access.concurrency.limit
  ) {
    return "share_concurrency_limit";
  }
  return null;
}

export function agentGUISharedAgentAllowsModel(
  input: AgentGUISharedAgentAccess | null | undefined,
  modelPlanId: string | null | undefined,
  model: string
): boolean {
  const access = normalizeAgentGUISharedAgentAccess(input);
  const allowed = access?.allowedModels ?? [];
  if (allowed.length === 0) return true;
  const normalizedPlanID = modelPlanId?.trim() ?? "";
  const normalizedModel = model.trim();
  return allowed.some((entry) => {
    const allowedPlanID = entry.modelPlanId?.trim() ?? "";
    return (
      (!allowedPlanID || allowedPlanID === normalizedPlanID) &&
      entry.model === normalizedModel
    );
  });
}

export function agentGUISharedAgentAllowsPolicy(
  input: AgentGUISharedAgentAccess | null | undefined,
  policy: keyof NonNullable<AgentGUISharedAgentAccess["policyPermissions"]>
): boolean {
  const access = normalizeAgentGUISharedAgentAccess(input);
  return access?.policyPermissions?.[policy] !== false;
}

function normalizeAllowedModels(
  input: AgentGUISharedAgentAccess["allowedModels"]
): Array<{ modelPlanId?: string; model: string }> {
  const result: Array<{ modelPlanId?: string; model: string }> = [];
  const seen = new Set<string>();
  for (const entry of input ?? []) {
    const model = entry.model.trim();
    const modelPlanId = entry.modelPlanId?.trim() ?? "";
    if (!model) continue;
    const key = `${modelPlanId}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...(modelPlanId ? { modelPlanId } : {}), model });
  }
  return result;
}

function normalizeNonNegativeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
