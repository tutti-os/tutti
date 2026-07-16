import { describe, expect, it } from "vitest";
import {
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_PROMPT,
  autoTokenBudget,
  buildPlanOrchestrationPrompt,
  estimatePlanIssueDraftCost,
  latestPlanTurnId,
  planIssueDraftFromPlanText,
  planImplementationPromptFromPlanTurn
} from "./planImplementationPresentation";

describe("plan implementation presentation", () => {
  it("exposes the semantic implement action and prompt copy", () => {
    expect(PLAN_IMPLEMENTATION_ACTION_IMPLEMENT).toBe("implement");
    expect(PLAN_IMPLEMENTATION_PROMPT).toBe("Implement the plan.");
  });

  it("projects a plan implementation prompt", () => {
    expect(
      planImplementationPromptFromPlanTurn("turn-1", "Implement?")
    ).toEqual({
      kind: "plan-implementation",
      requestId: "turn-1",
      title: "Implement?"
    });
  });

  it("returns the latest turn only when it contains a plan item", () => {
    expect(
      latestPlanTurnId([
        {
          turnId: "turn-1",
          occurredAtUnixMs: 1,
          payload: { messageKind: "plan" }
        },
        {
          turnId: "turn-2",
          occurredAtUnixMs: 2,
          payload: { messageKind: "text" }
        }
      ])
    ).toBeNull();
    expect(
      latestPlanTurnId([
        {
          turnId: "turn-1",
          occurredAtUnixMs: 1,
          payload: { messageKind: "text" }
        },
        {
          turnId: "turn-2",
          occurredAtUnixMs: 2,
          payload: { messageKind: "plan" }
        }
      ])
    ).toBe("turn-2");
  });

  it("turns an Ultra Plan into an editable Issue-level profile and task graph", () => {
    const draft = planIssueDraftFromPlanText(
      `\`\`\`tutti-issue-plan-v1
{"title":"Ship","reasoningIntensity":70,"orchestrationIntensity":80,"budgetMode":"auto","tasks":[{"id":"design","title":"Design"},{"id":"build","title":"Build","dependencyTaskIds":["design"]}]}
\`\`\``,
      "Approved plan"
    );

    expect(draft.planningSource).toBe("ultra_plan");
    expect(draft.stage).toBe("preview");
    expect(draft.executionProfile).toEqual({
      reasoningIntensity: 70,
      orchestrationIntensity: 80
    });
    expect(draft.budget).toEqual({
      mode: "auto",
      tokenLimit: autoTokenBudget(2, draft.executionProfile),
      quotaWaterlinePercent: 10
    });
    expect(draft.tasks).toMatchObject([
      { sourceId: "design", title: "Design" },
      { sourceId: "build", dependencySourceIds: ["design"] }
    ]);
  });

  it("does not treat an unrelated JSON fence as an Ultra Plan artifact", () => {
    const draft = planIssueDraftFromPlanText(
      `Plan the migration.\n\n\`\`\`json
{"tasks":[{"id":"accidental","title":"Example payload"}]}
\`\`\``,
      "Approved plan"
    );

    expect(draft.planningSource).toBe("traditional_plan");
    expect(draft.stage).toBe("budget");
    expect(draft.tasks).toHaveLength(1);
    expect(draft.tasks[0]?.sourceId).toBe("plan");
  });

  it("recognizes an Ultra narrative marker without prematurely creating tasks", () => {
    const draft = planIssueDraftFromPlanText(
      "# Migration plan\n\nReview the current schema.\n\n<!-- tutti-ultra-plan-v1 -->",
      "Approved plan"
    );

    expect(draft).toMatchObject({
      title: "Migration plan",
      planningSource: "ultra_plan",
      stage: "budget"
    });
    expect(draft.tasks).toHaveLength(1);
  });

  it("uses a caller-localized title when the plan has no title text", () => {
    const draft = planIssueDraftFromPlanText("```\n```", "已确认的方案");

    expect(draft.title).toBe("已确认的方案");
    expect(draft.tasks[0]?.title).toBe("已确认的方案");
  });

  it("clamps automatic token budgets to the daemon compiler bounds", () => {
    expect(
      autoTokenBudget(1, {
        reasoningIntensity: 0,
        orchestrationIntensity: 0
      })
    ).toBe(40_000);
    expect(
      autoTokenBudget(10_000, {
        reasoningIntensity: 100,
        orchestrationIntensity: 100
      })
    ).toBe(2_000_000);
  });

  it("uses the remembered pre-planning budget as the review default", () => {
    const draft = planIssueDraftFromPlanText(
      "# Migration plan",
      "Approved plan",
      {
        executionProfile: {
          reasoningIntensity: 72,
          orchestrationIntensity: 31
        },
        budget: {
          mode: "fixed",
          tokenLimit: 91_000,
          quotaWaterlinePercent: 14
        }
      }
    );

    expect(draft.executionProfile).toEqual({
      reasoningIntensity: 72,
      orchestrationIntensity: 31
    });
    expect(draft.budget).toEqual({
      mode: "fixed",
      tokenLimit: 91_000,
      quotaWaterlinePercent: 14
    });
  });

  it("keeps confirmed structured settings instead of overriding them with a preset", () => {
    const draft = planIssueDraftFromPlanText(
      `\`\`\`tutti-issue-plan-v1
{"title":"Ship","reasoningIntensity":80,"orchestrationIntensity":65,"budgetMode":"fixed","tokenBudget":120000,"quotaWaterlinePercent":20,"tasks":[{"id":"build","title":"Build"}]}
\`\`\``,
      "Approved plan",
      {
        executionProfile: {
          reasoningIntensity: 10,
          orchestrationIntensity: 20
        },
        budget: {
          mode: "fixed",
          tokenLimit: 30_000,
          quotaWaterlinePercent: 5
        }
      }
    );

    expect(draft.executionProfile).toEqual({
      reasoningIntensity: 80,
      orchestrationIntensity: 65
    });
    expect(draft.budget).toEqual({
      mode: "fixed",
      tokenLimit: 120_000,
      quotaWaterlinePercent: 20
    });
  });

  it("builds the follow-up task-graph instruction from confirmed settings", () => {
    const draft = planIssueDraftFromPlanText(
      "Plan the migration.\n\n<!-- tutti-ultra-plan-v1 -->",
      "Approved plan"
    );
    draft.executionProfile.reasoningIntensity = 73;
    draft.budget = {
      mode: "fixed",
      tokenLimit: 88_000,
      quotaWaterlinePercent: 15
    };

    const prompt = buildPlanOrchestrationPrompt(draft, {
      agents: [
        {
          agentTargetId: "local:codex",
          name: "Codex",
          purpose: "Implement repository changes",
          provider: "codex",
          modelPlanProtocol: "openai",
          available: true
        }
      ],
      modelPlans: [
        {
          id: "plan-1",
          name: "Plan One",
          protocol: "openai",
          status: "ready",
          available: true,
          models: [{ id: "model-1", name: "Model One" }]
        }
      ]
    });

    expect(prompt).toContain('"reasoningIntensity":73');
    expect(prompt).toContain('"tokenBudget":88000');
    expect(prompt).toContain('"planningSource":"ultra_plan"');
    expect(prompt).toContain('"agentTargetId":"local:codex"');
    expect(prompt).toContain('"purpose":"Implement repository changes"');
    expect(prompt).toContain('"id":"plan-1"');
    expect(prompt).toContain("reasoning intensity 67-100");
    expect(prompt).toContain("Orchestration intensity 67-100");
    expect(prompt).toContain("dispatches ready tasks sequentially");
    expect(prompt).toContain("unknown pricing is not evidence");
    expect(prompt).toContain("Plan the migration.");
    expect(prompt).toContain("tutti-issue-plan-v1");
  });

  it("estimates preview cost from per-task budget and selected model pricing", () => {
    const draft = planIssueDraftFromPlanText(
      `\`\`\`tutti-issue-plan-v1
{"title":"Ship","budgetMode":"fixed","tokenBudget":100000,"tasks":[{"id":"build","title":"Build","modelPlanId":"plan-1","model":"model-1"}]}
\`\`\``,
      "Approved plan"
    );

    expect(
      estimatePlanIssueDraftCost(draft, {
        agents: [],
        modelPlans: [
          {
            id: "plan-1",
            name: "Plan One",
            billingMode: "api_metered",
            protocol: "openai",
            status: "ready",
            available: true,
            defaultModel: "model-1",
            models: [
              {
                id: "model-1",
                name: "Model One",
                pricing: {
                  currency: "USD",
                  inputMicrosPerMillion: 10_000,
                  outputMicrosPerMillion: 20_000,
                  cacheReadMicrosPerMillion: 1_000,
                  cacheWriteMicrosPerMillion: 5_000
                }
              }
            ]
          }
        ]
      })
    ).toEqual({
      amounts: [{ currency: "USD", lowerMicros: 100, upperMicros: 2_000 }],
      pricedTaskCount: 1,
      taskCount: 1
    });
  });

  it("does not fabricate monetary cost for subscription quota plans", () => {
    const draft = planIssueDraftFromPlanText(
      `\`\`\`tutti-issue-plan-v1
{"title":"Ship","budgetMode":"fixed","tokenBudget":100000,"tasks":[{"id":"build","title":"Build","modelPlanId":"plan-1","model":"model-1"}]}
\`\`\``,
      "Approved plan"
    );

    expect(
      estimatePlanIssueDraftCost(draft, {
        agents: [],
        modelPlans: [
          {
            id: "plan-1",
            name: "Subscription",
            billingMode: "subscription_quota",
            protocol: "openai",
            status: "ready",
            available: true,
            models: [
              {
                id: "model-1",
                name: "Model One",
                pricing: {
                  currency: "USD",
                  inputMicrosPerMillion: 10_000,
                  outputMicrosPerMillion: 20_000,
                  cacheReadMicrosPerMillion: 1_000,
                  cacheWriteMicrosPerMillion: 5_000
                }
              }
            ]
          }
        ]
      })
    ).toEqual({ amounts: [], pricedTaskCount: 0, taskCount: 1 });
  });
});
