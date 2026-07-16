import type { AgentActivityAutomationRuleOverride } from "@tutti-os/agent-activity-core";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  toast
} from "@tutti-os/ui-system";
import { LoaderCircle, Workflow } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";

const DEFAULT_VALUE = "__automation_workspace_defaults__";
const DISABLED_VALUE = "__automation_disabled__";
const CUSTOM_VALUE = "__automation_custom__";
const RULE_PREFIX = "automation-rule:";

interface Input {
  agentSessionId: string | null;
  disabled: boolean;
  runtime: AgentActivityRuntime | null;
  workspaceId: string;
}

interface Result {
  controls: ReactNode;
  override: AgentActivityAutomationRuleOverride | null;
}

const inheritedOverride: AgentActivityAutomationRuleOverride = {
  disabled: false,
  ruleIds: []
};

/**
 * Session-local AutomationRule selection. Home selections ride on Session
 * creation so they are durable before the first turn; active-session changes
 * use the dedicated daemon override command.
 */
export function useComposerAutomationRuleOverride(input: Input): Result {
  const [rules, setRules] = useState<
    Array<{ id: string; name: string; action: string; trigger: string }>
  >([]);
  const [override, setOverride] =
    useState<AgentActivityAutomationRuleOverride>(inheritedOverride);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const listRules = input.runtime?.listAutomationRules;
    const workspaceId = input.workspaceId.trim();
    if (!listRules || !workspaceId) {
      setRules([]);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    void listRules({ workspaceId, signal: abort.signal })
      .then((result) => {
        if (abort.signal.aborted) return;
        setRules(
          result.rules
            .filter((rule) => rule.enabled && rule.id.trim())
            .map((rule) => ({
              id: rule.id.trim(),
              name: rule.name.trim() || rule.id.trim(),
              action: rule.action,
              trigger: rule.trigger
            }))
        );
      })
      .catch(() => {
        if (!abort.signal.aborted) setRules([]);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [input.runtime, input.workspaceId]);

  useEffect(() => {
    const agentSessionId = input.agentSessionId?.trim() ?? "";
    const workspaceId = input.workspaceId.trim();
    const getOverride = input.runtime?.getAutomationRuleOverride;
    if (!agentSessionId) {
      setOverride(inheritedOverride);
      return;
    }
    if (!getOverride || !workspaceId) return;
    const abort = new AbortController();
    setLoading(true);
    void getOverride({ agentSessionId, workspaceId, signal: abort.signal })
      .then((result) => {
        if (abort.signal.aborted) return;
        setOverride({
          disabled: result.disabled,
          ruleIds: [...result.ruleIds]
        });
      })
      .catch(() => {
        if (!abort.signal.aborted) setOverride(inheritedOverride);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [input.agentSessionId, input.runtime, input.workspaceId]);

  const value = automationOverrideValue(override);
  const selectedLabel = automationOverrideLabel({
    ruleCount: override.ruleIds.length,
    rules,
    value
  });

  if (
    rules.length === 0 ||
    !input.runtime?.listAutomationRules ||
    !input.runtime?.setAutomationRuleOverride
  ) {
    return { controls: null, override: normalizedSubmitOverride(override) };
  }

  const apply = async (next: AgentActivityAutomationRuleOverride) => {
    const agentSessionId = input.agentSessionId?.trim() ?? "";
    if (!agentSessionId) {
      setOverride(next);
      return;
    }
    const setOverrideCommand = input.runtime?.setAutomationRuleOverride;
    if (!setOverrideCommand || pending) return;
    setPending(true);
    try {
      const result = await setOverrideCommand({
        agentSessionId,
        workspaceId: input.workspaceId,
        disabled: next.disabled,
        ruleIds: [...next.ruleIds]
      });
      setOverride({ disabled: result.disabled, ruleIds: [...result.ruleIds] });
    } catch {
      toast.error(translate("agentHost.agentGui.automationSessionSaveFailed"));
    } finally {
      setPending(false);
    }
  };

  return {
    controls: (
      <section className="mx-2 mb-1 mt-0 flex min-w-0 items-center gap-2 rounded-[8px] border border-[var(--line-2)] bg-[var(--background-secondary)] px-2.5 py-2 text-[12px] text-[var(--text-secondary)]">
        {loading || pending ? (
          <LoaderCircle
            aria-hidden="true"
            className="shrink-0 animate-spin"
            size={13}
          />
        ) : (
          <Workflow aria-hidden="true" className="shrink-0" size={13} />
        )}
        <span className="shrink-0 font-medium text-[var(--text-primary)]">
          {translate("agentHost.agentGui.automationSessionLabel")}
        </span>
        <Select
          disabled={input.disabled || loading || pending}
          value={value}
          onValueChange={(nextValue) => {
            const next = automationOverrideFromValue(nextValue);
            if (next) void apply(next);
          }}
        >
          <SelectTrigger
            aria-label={translate("agentHost.agentGui.automationSessionLabel")}
            className="h-7 min-w-0 flex-1 rounded-[6px] border-[var(--line-2)] bg-[var(--background-fronted)] px-2 text-[12px]"
          >
            <span className="truncate">{selectedLabel}</span>
          </SelectTrigger>
          <SelectContent align="start" side="top">
            <SelectItem value={DEFAULT_VALUE}>
              {translate("agentHost.agentGui.automationSessionDefaults")}
            </SelectItem>
            <SelectItem value={DISABLED_VALUE}>
              {translate("agentHost.agentGui.automationSessionOff")}
            </SelectItem>
            {value === CUSTOM_VALUE ? (
              <SelectItem disabled value={CUSTOM_VALUE}>
                {selectedLabel}
              </SelectItem>
            ) : null}
            {rules.map((rule) => (
              <SelectItem key={rule.id} value={`${RULE_PREFIX}${rule.id}`}>
                {rule.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>
    ),
    override: normalizedSubmitOverride(override)
  };
}

function automationOverrideLabel(input: {
  ruleCount: number;
  rules: Array<{ id: string; name: string }>;
  value: string;
}): string {
  if (input.value === DEFAULT_VALUE) {
    return translate("agentHost.agentGui.automationSessionDefaults");
  }
  if (input.value === DISABLED_VALUE) {
    return translate("agentHost.agentGui.automationSessionOff");
  }
  if (input.value === CUSTOM_VALUE) {
    return translate("agentHost.agentGui.automationSessionSelectedCount", {
      count: String(input.ruleCount)
    });
  }
  const id = input.value.slice(RULE_PREFIX.length);
  return input.rules.find((rule) => rule.id === id)?.name ?? id;
}

function automationOverrideValue(
  override: AgentActivityAutomationRuleOverride
): string {
  if (override.disabled) return DISABLED_VALUE;
  if (override.ruleIds.length === 0) return DEFAULT_VALUE;
  if (override.ruleIds.length === 1)
    return `${RULE_PREFIX}${override.ruleIds[0]}`;
  return CUSTOM_VALUE;
}

function automationOverrideFromValue(
  value: string
): AgentActivityAutomationRuleOverride | null {
  if (value === DEFAULT_VALUE) return inheritedOverride;
  if (value === DISABLED_VALUE) return { disabled: true, ruleIds: [] };
  if (value.startsWith(RULE_PREFIX)) {
    const ruleId = value.slice(RULE_PREFIX.length).trim();
    return ruleId ? { disabled: false, ruleIds: [ruleId] } : null;
  }
  return null;
}

function normalizedSubmitOverride(
  override: AgentActivityAutomationRuleOverride
): AgentActivityAutomationRuleOverride | null {
  return override.disabled || override.ruleIds.length > 0
    ? { disabled: override.disabled, ruleIds: [...override.ruleIds] }
    : null;
}
