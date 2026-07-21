import { useState, type JSX } from "react";
import { MessageCircleQuestion } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  cn,
  toast
} from "@tutti-os/ui-system";
import type { AgentActivityModelPlanSummary } from "@tutti-os/agent-activity-core";
import { translate } from "../../i18n/index";
import { useOptionalAgentHostApi } from "../../agentActivityHost";
import { useOptionalAgentActivityRuntime } from "../../agentActivityRuntime";
import styles from "./AgentGUINode.styles";

export const MODEL_CONSULT_CONTEXT_MAX_CHARS = 4000;

export interface AgentModelConsultContext {
  agentSessionId: string;
  /** Last assistant reply in the projected timeline (context checkbox). */
  lastAssistantMessageText: string | null;
}

/**
 * Composer-footer entry for an explicit model consult (显式模型咨询): pick an
 * enabled model access plan + model, ask a question (prefilled from the
 * current composer draft without clearing it), optionally attach the latest
 * assistant reply as context, then start the consult through
 * `AgentActivityRuntime.startModelConsult`. The resulting collaboration card
 * arrives via the normal activity update pipeline, so success needs no local
 * insertion. Hidden entirely when the runtime does not implement the command
 * or there is no active session.
 */
export function AgentModelConsultControl({
  workspaceId,
  consultContext,
  draftPrompt,
  disabled = false,
  previewMode = false
}: {
  workspaceId: string;
  consultContext: AgentModelConsultContext | null;
  /** Current composer draft text used to prefill the question. */
  draftPrompt: string;
  disabled?: boolean;
  previewMode?: boolean;
}): JSX.Element | null {
  "use memo";
  const agentHostApi = useOptionalAgentHostApi();
  const runtime = useOptionalAgentActivityRuntime();
  const [open, setOpen] = useState(false);
  const [plans, setPlans] = useState<AgentActivityModelPlanSummary[] | null>(
    null
  );
  const [plansError, setPlansError] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [question, setQuestion] = useState("");
  const [includeContext, setIncludeContext] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const startModelConsult = runtime?.startModelConsult;
  if (!startModelConsult || !consultContext || previewMode) {
    return null;
  }

  const enabledPlans = plans?.filter((plan) => plan.enabled) ?? null;
  const selectedPlan =
    enabledPlans?.find((plan) => plan.id === selectedPlanId) ?? null;
  const contextText = consultContext.lastAssistantMessageText?.trim() ?? "";
  const canSubmit = Boolean(
    selectedPlan && selectedModel.trim() && question.trim() && !submitting
  );

  const showErrorToast = (message: string): void => {
    if (agentHostApi?.toast?.error) {
      agentHostApi.toast.error(message);
      return;
    }
    toast.error(message);
  };

  const loadPlans = async (): Promise<void> => {
    const listModelPlans = runtime?.listModelPlans;
    if (!listModelPlans) {
      setPlans([]);
      return;
    }
    setPlansError(false);
    try {
      const result = await listModelPlans({ workspaceId });
      const nextEnabledPlans = result.plans.filter((plan) => plan.enabled);
      setPlans(result.plans);
      // Seed the pickers once per open so a manual pick is never clobbered.
      const firstPlan = nextEnabledPlans[0] ?? null;
      setSelectedPlanId((current) =>
        current && nextEnabledPlans.some((plan) => plan.id === current)
          ? current
          : (firstPlan?.id ?? "")
      );
      if (firstPlan) {
        setSelectedModel((current) =>
          current && firstPlan.models.some((model) => model.id === current)
            ? current
            : (firstPlan.defaultModel ?? firstPlan.models[0]?.id ?? "")
        );
      }
    } catch {
      setPlans([]);
      setPlansError(true);
      showErrorToast(translate("agentHost.agentGui.consultLoadPlansFailed"));
    }
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);
    if (!nextOpen) {
      return;
    }
    // Prefill the question from the current composer draft without touching
    // (or later clearing) the draft itself.
    setQuestion((current) => (current.trim() ? current : draftPrompt));
    setIncludeContext(false);
    void loadPlans();
  };

  const handlePlanChange = (planId: string): void => {
    setSelectedPlanId(planId);
    const plan = enabledPlans?.find((candidate) => candidate.id === planId);
    setSelectedModel(plan?.defaultModel ?? plan?.models[0]?.id ?? "");
  };

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit || !selectedPlan) {
      return;
    }
    setSubmitting(true);
    try {
      await startModelConsult({
        agentSessionId: consultContext.agentSessionId,
        contextText:
          includeContext && contextText
            ? contextText.slice(0, MODEL_CONSULT_CONTEXT_MAX_CHARS)
            : undefined,
        model: selectedModel,
        modelPlanId: selectedPlan.id,
        question: question.trim(),
        workspaceId
      });
      // The collaboration card arrives via activity events; just close.
      setOpen(false);
      setQuestion("");
    } catch {
      showErrorToast(translate("agentHost.agentGui.consultFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={translate("agentHost.agentGui.consultEntryLabel")}
          title={translate("agentHost.agentGui.consultEntryLabel")}
          data-agent-model-consult-trigger="true"
          className={cn(
            "w-auto",
            styles.composerMenuTrigger,
            disabled &&
              "cursor-not-allowed text-[var(--agent-gui-text-tertiary)] opacity-60 hover:text-[var(--agent-gui-text-tertiary)]"
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <MessageCircleQuestion
              aria-hidden
              className="size-3.5 shrink-0"
              strokeWidth={2}
            />
            <span className="min-w-0 truncate">
              {translate("agentHost.agentGui.consultEntryLabel")}
            </span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        collisionPadding={16}
        className="box-border flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-2.5 rounded-[10px] border border-[var(--line-2)] bg-[var(--background-fronted)] p-3 shadow-lg"
        data-agent-model-consult-popover="true"
      >
        <div className="text-[13px] font-medium text-[var(--text-primary)]">
          {translate("agentHost.agentGui.consultDialogTitle")}
        </div>
        {enabledPlans !== null && enabledPlans.length === 0 ? (
          <div
            data-agent-model-consult-empty="true"
            className="text-[12px] text-[var(--text-tertiary)]"
          >
            {translate(
              plansError
                ? "agentHost.agentGui.consultLoadPlansFailed"
                : "agentHost.agentGui.consultNoPlans"
            )}
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-tertiary)]">
              {translate("agentHost.agentGui.consultPlanLabel")}
              <Select
                value={selectedPlanId || undefined}
                onValueChange={handlePlanChange}
              >
                <SelectTrigger
                  data-agent-model-consult-plan-trigger="true"
                  className="h-7 w-full justify-between rounded-[6px] border border-[var(--line-2)] px-2 text-[12px] text-[var(--text-primary)]"
                >
                  <span className="min-w-0 truncate">
                    {selectedPlan?.name ?? ""}
                  </span>
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  {(enabledPlans ?? []).map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-tertiary)]">
              {translate("agentHost.agentGui.consultModelLabel")}
              <Select
                value={selectedModel || undefined}
                onValueChange={setSelectedModel}
              >
                <SelectTrigger
                  data-agent-model-consult-model-trigger="true"
                  className="h-7 w-full justify-between rounded-[6px] border border-[var(--line-2)] px-2 text-[12px] text-[var(--text-primary)]"
                >
                  <span className="min-w-0 truncate">
                    {selectedPlan?.models.find(
                      (model) => model.id === selectedModel
                    )?.name ?? selectedModel}
                  </span>
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  {(selectedPlan?.models ?? []).map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-tertiary)]">
              {translate("agentHost.agentGui.consultQuestionLabel")}
              <textarea
                value={question}
                rows={3}
                data-agent-model-consult-question="true"
                placeholder={translate(
                  "agentHost.agentGui.consultQuestionPlaceholder"
                )}
                className="box-border w-full resize-y rounded-[6px] border border-[var(--line-2)] bg-transparent px-2 py-1.5 text-[12px] leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--agent-gui-text-tertiary)] focus:border-[var(--tutti-purple)]"
                onChange={(event) => setQuestion(event.target.value)}
              />
            </label>
            {contextText ? (
              <label className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={includeContext}
                  data-agent-model-consult-context="true"
                  className="size-3.5 shrink-0 accent-[var(--tutti-purple)]"
                  onChange={(event) => setIncludeContext(event.target.checked)}
                />
                <span className="min-w-0">
                  {translate("agentHost.agentGui.consultIncludeContextLabel")}
                </span>
              </label>
            ) : null}
            <div className="flex justify-end">
              <button
                type="button"
                disabled={!canSubmit}
                data-agent-model-consult-submit="true"
                className="inline-flex h-7 items-center rounded-[6px] bg-[var(--tutti-purple)] px-3 text-[12px] font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleSubmit()}
              >
                {translate(
                  submitting
                    ? "agentHost.agentGui.consultSubmitting"
                    : "agentHost.agentGui.consultSubmit"
                )}
              </button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
