import type { AgentConversationPromptVM } from "./contracts/agentConversationVM";

export const PLAN_IMPLEMENTATION_PROMPT = "Implement the plan.";
export const PLAN_IMPLEMENTATION_ACTION_IMPLEMENT = "implement";
export const PLAN_IMPLEMENTATION_ACTION_CREATE_ISSUE = "create_issue";
export const PLAN_IMPLEMENTATION_ACTION_ORCHESTRATE = "orchestrate_issue";
export const PLAN_IMPLEMENTATION_ACTION_FEEDBACK = "feedback";
export const PLAN_IMPLEMENTATION_ACTION_SKIP = "skip";
export const MINIMUM_AUTO_TOKEN_BUDGET = 32_000;
export const MAXIMUM_AUTO_TOKEN_BUDGET = 2_000_000;

/**
 * The editable, credential-free execution proposal derived from a Plan turn.
 * The agent proposes it; the user is authoritative for all values before an
 * Issue is created.  Keep this independent from the daemon request shape so
 * every host (desktop now, remote hosts later) can render the same review.
 */
export interface PlanIssueDraft {
  title: string;
  content: string;
  stage: "budget" | "preview";
  planningSource: "traditional_plan" | "ultra_plan";
  executionProfile: PlanIssueExecutionProfile;
  budget: PlanIssueBudget;
  tasks: PlanIssueTaskDraft[];
}

export interface PlanIssueExecutionProfile {
  reasoningIntensity: number;
  orchestrationIntensity: number;
}

export interface PlanIssueBudget {
  mode: "auto" | "fixed";
  tokenLimit: number;
  quotaWaterlinePercent: number;
}

/**
 * Remembered planning defaults chosen before a Plan turn is submitted. The
 * generated plan can still provide explicit values; otherwise these values
 * seed the mandatory Issue-decomposition review.
 */
export interface PlanIssueBudgetPreset {
  executionProfile: PlanIssueExecutionProfile;
  budget: PlanIssueBudget;
}

export interface PlanIssueTaskDraft {
  /** Stable only within this proposal; dependency ids refer to this key. */
  sourceId: string;
  title: string;
  content: string;
  priority: "high" | "medium" | "low";
  agentTargetId?: string;
  modelPlanId?: string;
  model?: string;
  executionDirectory?: string;
  dependencySourceIds: string[];
}

export interface PlanIssueCreationOptions {
  /** False means create the Issue but defer every task dispatch. */
  startExecution: boolean;
  /** Defaults to sequential for compatibility with older hosts. */
  executionMode?: "sequential" | "parallel";
  draft: PlanIssueDraft;
}

export interface PlanOrchestrationCatalog {
  agents: Array<{
    agentTargetId: string;
    name: string;
    purpose: string;
    provider: string;
    modelPlanProtocol?: string;
    available: boolean;
  }>;
  modelPlans: Array<{
    id: string;
    name: string;
    billingMode?: "api_metered" | "subscription_quota" | string;
    protocol: string;
    status: string;
    available: boolean;
    defaultModel?: string;
    models: Array<{
      id: string;
      name: string;
      tier?: string;
      capabilities?: string[];
      pricing?: {
        currency: string;
        inputMicrosPerMillion: number;
        outputMicrosPerMillion: number;
        cacheReadMicrosPerMillion: number;
        cacheWriteMicrosPerMillion: number;
      } | null;
    }>;
  }>;
}

export function planImplementationPromptFromPlanTurn(
  planTurnId: string,
  title: string,
  issueDraft?: PlanIssueDraft,
  assignmentCatalog?: PlanOrchestrationCatalog
): Extract<AgentConversationPromptVM, { kind: "plan-implementation" }> {
  return {
    kind: "plan-implementation",
    requestId: planTurnId,
    title,
    ...(issueDraft ? { issueDraft } : {}),
    ...(assignmentCatalog ? { assignmentCatalog } : {})
  };
}

export interface PlanIssueCostEstimate {
  amounts: Array<{
    currency: string;
    lowerMicros: number;
    upperMicros: number;
  }>;
  pricedTaskCount: number;
  taskCount: number;
}

/**
 * Preview estimate aligned with the daemon's no-history fallback: split the
 * Issue token budget across tasks and apply each selected model's lowest and
 * highest token-category rates. The range stays explicit because the eventual
 * input/output/cache mix is not known at decomposition time. Unknown pricing
 * remains unknown.
 */
export function estimatePlanIssueDraftCost(
  draft: PlanIssueDraft,
  catalog?: PlanOrchestrationCatalog | null
): PlanIssueCostEstimate {
  const taskCount = draft.tasks.length;
  if (!catalog || taskCount === 0) {
    return { amounts: [], pricedTaskCount: 0, taskCount };
  }
  const perTaskTokens = Math.floor(draft.budget.tokenLimit / taskCount);
  const amountsByCurrency = new Map<
    string,
    { lowerMicros: number; upperMicros: number }
  >();
  let pricedTaskCount = 0;
  for (const task of draft.tasks) {
    const plan = catalog.modelPlans.find(
      (candidate) => candidate.id === task.modelPlanId && candidate.available
    );
    if (!plan || plan.billingMode !== "api_metered") continue;
    const modelId = task.model?.trim() || plan.defaultModel?.trim() || "";
    const pricing = plan.models.find((model) => model.id === modelId)?.pricing;
    if (!pricing?.currency.trim()) continue;
    const rates = [
      pricing.inputMicrosPerMillion,
      pricing.outputMicrosPerMillion,
      pricing.cacheReadMicrosPerMillion,
      pricing.cacheWriteMicrosPerMillion
    ];
    if (rates.some((rate) => !Number.isFinite(rate) || rate < 0)) continue;
    const lowerMicros = Math.round(
      (perTaskTokens * Math.min(...rates)) / 1_000_000
    );
    const upperMicros = Math.round(
      (perTaskTokens * Math.max(...rates)) / 1_000_000
    );
    const currency = pricing.currency.trim().toUpperCase();
    const current = amountsByCurrency.get(currency) ?? {
      lowerMicros: 0,
      upperMicros: 0
    };
    amountsByCurrency.set(currency, {
      lowerMicros: current.lowerMicros + lowerMicros,
      upperMicros: current.upperMicros + upperMicros
    });
    pricedTaskCount += 1;
  }
  return {
    amounts: [...amountsByCurrency]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amount]) => ({ currency, ...amount })),
    pricedTaskCount,
    taskCount
  };
}

interface PlanTimelineItem {
  turnId?: string | null;
  occurredAtUnixMs?: number | null;
  createdAtUnixMs?: number | null;
  seq?: number | null;
  payload?: Record<string, unknown> | null;
  content?: string | null;
}

function itemTime(item: PlanTimelineItem): number {
  return item.occurredAtUnixMs ?? item.createdAtUnixMs ?? item.seq ?? 0;
}

function isPlanItem(item: PlanTimelineItem): boolean {
  return item.payload?.messageKind === "plan";
}

export function latestPlanTurnId(
  timelineItems: readonly PlanTimelineItem[]
): string | null {
  let latestTurnId: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const item of timelineItems) {
    const turnId = item.turnId?.trim();
    if (!turnId) continue;
    const time = itemTime(item);
    if (time >= latestTime) {
      latestTime = time;
      latestTurnId = turnId;
    }
  }
  if (!latestTurnId) return null;
  return timelineItems.some(
    (item) => item.turnId?.trim() === latestTurnId && isPlanItem(item)
  )
    ? latestTurnId
    : null;
}

/** Builds a user-reviewable Issue proposal from the plan message in a timeline. */
export function planIssueDraftFromTimelineItems(
  timelineItems: readonly PlanTimelineItem[],
  planTurnId: string,
  fallbackTitle: string,
  preset?: PlanIssueBudgetPreset | null
): PlanIssueDraft | null {
  const item = timelineItems.find(
    (candidate) =>
      candidate.turnId?.trim() === planTurnId && isPlanItem(candidate)
  );
  const text =
    stringValue(item?.content) ??
    stringValue(item?.payload?.text) ??
    stringValue(item?.payload?.content) ??
    stringValue(item?.payload?.plan) ??
    stringValue(item?.payload?.body);
  return text ? planIssueDraftFromPlanText(text, fallbackTitle, preset) : null;
}

/**
 * Parses the Ultra Plan fenced block when present and otherwise turns a normal
 * Plan into one reviewable task. Invalid model output intentionally degrades
 * to the normal Plan representation instead of creating an unusable Issue.
 */
export function planIssueDraftFromPlanText(
  planText: string,
  fallbackTitle: string,
  preset?: PlanIssueBudgetPreset | null
): PlanIssueDraft {
  const structured = parseStructuredPlan(planText);
  const normalizedPreset = preset ?? defaultPlanIssueBudgetPreset();
  const profile: PlanIssueExecutionProfile = {
    reasoningIntensity:
      percentValue(structured?.reasoningIntensity) ??
      normalizedPreset.executionProfile.reasoningIntensity,
    orchestrationIntensity:
      percentValue(structured?.orchestrationIntensity) ??
      normalizedPreset.executionProfile.orchestrationIntensity
  };
  const structuredTasks = Array.isArray(structured?.tasks)
    ? structured.tasks
    : [];
  const tasks = structuredTasks.flatMap((task, index) => {
    const title = stringValue(task.title);
    if (!title) return [];
    return [
      {
        sourceId:
          stringValue(task.taskId) ??
          stringValue(task.id) ??
          `task-${index + 1}`,
        title,
        content: stringValue(task.content) ?? "",
        priority: priorityValue(task.priority),
        agentTargetId: stringValue(task.agentTargetId),
        modelPlanId: stringValue(task.modelPlanId),
        model: stringValue(task.model),
        executionDirectory: stringValue(task.executionDirectory),
        dependencySourceIds: arrayOfStrings(task.dependencyTaskIds)
      } satisfies PlanIssueTaskDraft
    ];
  });
  const title =
    stringValue(structured?.title) ??
    titleFromPlanText(planText, fallbackTitle);
  const normalizedTasks =
    tasks.length > 0
      ? tasks
      : [
          {
            sourceId: "plan",
            title,
            content: planText,
            priority: "medium" as const,
            dependencySourceIds: []
          }
        ];
  const specifiedBudgetMode = stringValue(structured?.budgetMode);
  const specifiedBudget = positiveInteger(structured?.tokenBudget);
  const hasStructuredBudget =
    specifiedBudgetMode === "auto" ||
    (specifiedBudgetMode === "fixed" && specifiedBudget !== undefined);
  const mode = hasStructuredBudget
    ? specifiedBudgetMode === "fixed"
      ? "fixed"
      : "auto"
    : normalizedPreset.budget.mode;
  return {
    title,
    content: stringValue(structured?.content) ?? planText,
    stage: tasks.length > 0 ? "preview" : "budget",
    planningSource:
      planningSourceValue(structured?.planningSource) ??
      (tasks.length > 0 || hasUltraPlanMarker(planText)
        ? "ultra_plan"
        : "traditional_plan"),
    executionProfile: profile,
    budget: {
      mode,
      tokenLimit:
        mode === "fixed"
          ? (specifiedBudget ?? normalizedPreset.budget.tokenLimit)
          : autoTokenBudget(normalizedTasks.length, profile),
      quotaWaterlinePercent:
        percentValue(structured?.quotaWaterlinePercent) ??
        normalizedPreset.budget.quotaWaterlinePercent
    },
    tasks: normalizedTasks
  };
}

export function defaultPlanIssueBudgetPreset(): PlanIssueBudgetPreset {
  const executionProfile: PlanIssueExecutionProfile = {
    reasoningIntensity: 50,
    orchestrationIntensity: 50
  };
  return {
    executionProfile,
    budget: {
      mode: "auto",
      tokenLimit: autoTokenBudget(1, executionProfile),
      quotaWaterlinePercent: 10
    }
  };
}

/** Strict persisted-state reader; malformed values are dropped safely. */
export function normalizePlanIssueBudgetPreset(
  value: unknown
): PlanIssueBudgetPreset | null {
  if (!isRecord(value)) return null;
  const executionProfileValue = isRecord(value.executionProfile)
    ? value.executionProfile
    : null;
  const budgetValue = isRecord(value.budget) ? value.budget : null;
  if (!executionProfileValue || !budgetValue) return null;
  const reasoningIntensity = percentValue(
    executionProfileValue.reasoningIntensity
  );
  const orchestrationIntensity = percentValue(
    executionProfileValue.orchestrationIntensity
  );
  const mode = budgetValue.mode === "fixed" ? "fixed" : "auto";
  const tokenLimit = positiveInteger(budgetValue.tokenLimit);
  const quotaWaterlinePercent = percentValue(budgetValue.quotaWaterlinePercent);
  if (
    reasoningIntensity === undefined ||
    orchestrationIntensity === undefined ||
    tokenLimit === undefined ||
    quotaWaterlinePercent === undefined
  ) {
    return null;
  }
  return {
    executionProfile: { reasoningIntensity, orchestrationIntensity },
    budget: { mode, tokenLimit, quotaWaterlinePercent }
  };
}

export function planIssueBudgetPresetsEqual(
  left: PlanIssueBudgetPreset | null | undefined,
  right: PlanIssueBudgetPreset | null | undefined
): boolean {
  return (
    (left?.executionProfile.reasoningIntensity ?? null) ===
      (right?.executionProfile.reasoningIntensity ?? null) &&
    (left?.executionProfile.orchestrationIntensity ?? null) ===
      (right?.executionProfile.orchestrationIntensity ?? null) &&
    (left?.budget.mode ?? null) === (right?.budget.mode ?? null) &&
    (left?.budget.tokenLimit ?? null) === (right?.budget.tokenLimit ?? null) &&
    (left?.budget.quotaWaterlinePercent ?? null) ===
      (right?.budget.quotaWaterlinePercent ?? null)
  );
}

/**
 * Builds the private runtime instruction sent after the user confirms the
 * Issue-level reasoning/orchestration budget. The plan narrative remains the
 * source of truth; this turn only decomposes it into an editable task graph.
 */
export function buildPlanOrchestrationPrompt(
  draft: PlanIssueDraft,
  catalog?: PlanOrchestrationCatalog
): string {
  const settings = {
    reasoningIntensity: draft.executionProfile.reasoningIntensity,
    orchestrationIntensity: draft.executionProfile.orchestrationIntensity,
    budgetMode: draft.budget.mode,
    tokenBudget: draft.budget.tokenLimit,
    quotaWaterlinePercent: draft.budget.quotaWaterlinePercent
  };
  const artifactShape = JSON.stringify({
    title: "...",
    content: "...",
    planningSource: draft.planningSource,
    ...settings,
    tasks: [
      {
        id: "task-1",
        title: "...",
        content: "...",
        priority: "medium",
        agentTargetId: "...",
        modelPlanId: "...",
        model: "...",
        dependencyTaskIds: []
      }
    ]
  });
  const availableCatalog = catalog ?? { agents: [], modelPlans: [] };
  return `The user confirmed the Issue-level orchestration settings below. Continue planning only: do not implement or edit files. Decompose the approved plan narrative into an executable task graph, assign an Agent target and compatible Model Plan/model only where known, and declare dependency task ids. Preserve the confirmed settings exactly. Do not assign execution directories: the host owns source-checkout selection and creates isolated Git worktrees for parallel execution. The Issue executor dispatches ready tasks sequentially by default, so dependencies express ordering and acceptance gates independently of the later execution-mode choice.

Confirmed settings: ${JSON.stringify(settings)}

Credential-free assignment catalog: ${JSON.stringify(availableCatalog)}

Only use exact Agent ids and Model Plan ids whose available value is true, and model ids listed under the selected available Model Plan. An Agent and Model Plan are compatible only when agent.modelPlanProtocol equals modelPlan.protocol. Apply the confirmed execution profile deterministically: reasoning intensity 67-100 favors the most capable relevant model tier/capabilities, 0-33 favors the least expensive model that is still sufficient, and the middle range balances capability and cost. Orchestration intensity 67-100 favors meaningful specialization and smaller dependency-linked tasks, while 0-33 minimizes task splits and Agent handoffs. Among compatible api_metered models that are equally sufficient, prefer the lower highest known token rate; unknown pricing is not evidence that a model is cheaper. subscription_quota plans have no monetary marginal price and must never be treated as free or assigned a fabricated amount. Stay within the confirmed Issue token budget. If no compatible available entry exists, omit the optional assignment fields so the user can choose them in task preview.

Approved plan narrative:
${draft.content}

End with exactly one fenced block tagged tutti-issue-plan-v1 containing valid JSON with this shape: ${artifactShape}. Dependency ids must reference task ids in the same array. Reasoning and budget are Issue-level only: never specify them per task. Omit unknown optional assignment fields; never invent credentials, owner ids, provider account metadata, prices, Agents, Model Plans, models, or execution directories.`;
}

export function autoTokenBudget(
  taskCount: number,
  profile: PlanIssueExecutionProfile
): number {
  const count = Number.isSafeInteger(taskCount) ? Math.max(1, taskCount) : 1;
  const compiled =
    16_000 +
    count *
      (24_000 +
        Math.round(profile.reasoningIntensity) * 320 +
        Math.round(profile.orchestrationIntensity) * 160);
  return Math.min(
    MAXIMUM_AUTO_TOKEN_BUDGET,
    Math.max(MINIMUM_AUTO_TOKEN_BUDGET, compiled)
  );
}

interface StructuredPlan {
  title?: unknown;
  content?: unknown;
  planningSource?: unknown;
  reasoningIntensity?: unknown;
  orchestrationIntensity?: unknown;
  budgetMode?: unknown;
  tokenBudget?: unknown;
  quotaWaterlinePercent?: unknown;
  tasks?: unknown;
}

function hasUltraPlanMarker(planText: string): boolean {
  return /<!--\s*tutti-ultra-plan-v1\s*-->/iu.test(planText);
}

function planningSourceValue(
  value: unknown
): PlanIssueDraft["planningSource"] | undefined {
  return value === "traditional_plan" || value === "ultra_plan"
    ? value
    : undefined;
}

function parseStructuredPlan(planText: string): StructuredPlan | null {
  const match = /```tutti-issue-plan-v1\s*\n([\s\S]*?)\n```/iu.exec(planText);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const plan = parsed as StructuredPlan;
    return Array.isArray(plan.tasks) ? plan : null;
  } catch {
    return null;
  }
}

function titleFromPlanText(planText: string, fallbackTitle: string): string {
  const heading = planText
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*#+\s*/u, "").trim())
    .find((line) => line.length > 0 && !line.startsWith("```"));
  return (heading ?? fallbackTitle.trim()).slice(0, 200);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const normalized = stringValue(entry);
        return normalized ? [normalized] : [];
      })
    : [];
}

function percentValue(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function priorityValue(value: unknown): PlanIssueTaskDraft["priority"] {
  return value === "high" || value === "low" ? value : "medium";
}
