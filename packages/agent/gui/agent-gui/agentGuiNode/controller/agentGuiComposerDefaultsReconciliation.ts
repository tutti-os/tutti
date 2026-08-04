import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import {
  rememberComposerDefaultsFields,
  normalizedComposerDefaultValue,
  type AgentGUIComposerDefaults,
  type AgentGUIComposerDefaultsField,
  type AgentGUIRememberComposerDefaultsResult
} from "./agentGuiController.providerHelpers";

interface AgentGUIComposerDefaultsGeneration {
  generation: number;
  value: string;
}

interface AgentGUIAcknowledgedComposerDefaultsGeneration extends AgentGUIComposerDefaultsGeneration {
  confirmationReadsRemaining: number;
}

const composerDefaultsConfirmationReadLimit = 2;

export interface AgentGUIComposerDefaultsMutation {
  draftKey: string;
  fields: Partial<
    Record<AgentGUIComposerDefaultsField, AgentGUIComposerDefaultsGeneration>
  >;
}

export interface AgentGUIComposerDefaultsLedger {
  acknowledgedByDraftKey: Record<
    string,
    Partial<
      Record<
        AgentGUIComposerDefaultsField,
        AgentGUIAcknowledgedComposerDefaultsGeneration
      >
    >
  >;
  latestByDraftKey: Record<
    string,
    Partial<Record<AgentGUIComposerDefaultsField, number>>
  >;
  nextGeneration: number;
}

export interface AgentGUIRetiredComposerDefault {
  field: AgentGUIComposerDefaultsField;
  value: string;
}

export interface AgentGUIComposerDefaultsAuthorityRead {
  force: boolean;
  receipt: AgentGUIComposerDefaultsAuthorityReadReceipt | null;
  settings: AgentSessionComposerSettings;
}

export interface AgentGUIComposerDefaultsAuthorityReadReceipt {
  draftKey: string;
  fields: Partial<
    Record<AgentGUIComposerDefaultsField, AgentGUIComposerDefaultsGeneration>
  >;
}

export interface AgentGUIComposerDefaultsAuthorityReconciler {
  prepareRead(
    target: AgentGUIComposerTargetData,
    settings: AgentSessionComposerSettings
  ): AgentGUIComposerDefaultsAuthorityRead;
  reconcileHomeDefaults(
    target: AgentGUIComposerTargetData,
    options: AgentActivityComposerOptions
  ): void;
  reloaded(
    receipt: AgentGUIComposerDefaultsAuthorityReadReceipt | null,
    options: AgentActivityComposerOptions
  ): void;
}

export function createAgentGUIComposerDefaultsLedger(): AgentGUIComposerDefaultsLedger {
  return {
    acknowledgedByDraftKey: {},
    latestByDraftKey: {},
    nextGeneration: 0
  };
}

export function registerAgentGUIComposerDefaultsMutation(
  ledger: AgentGUIComposerDefaultsLedger,
  draftKey: string,
  defaults: AgentGUIComposerDefaults
): AgentGUIComposerDefaultsMutation {
  const latest = (ledger.latestByDraftKey[draftKey] ??= {});
  const acknowledged = (ledger.acknowledgedByDraftKey[draftKey] ??= {});
  const fields: AgentGUIComposerDefaultsMutation["fields"] = {};
  for (const field of rememberComposerDefaultsFields) {
    const value = normalizedComposerDefaultValue(defaults, field);
    if (value === null) continue;
    const generation = ++ledger.nextGeneration;
    latest[field] = generation;
    delete acknowledged[field];
    fields[field] = { generation, value };
  }
  return { draftKey, fields };
}

export function acknowledgeAgentGUIComposerDefaultsMutation(
  ledger: AgentGUIComposerDefaultsLedger,
  mutation: AgentGUIComposerDefaultsMutation,
  result: AgentGUIRememberComposerDefaultsResult
): boolean {
  const latest = ledger.latestByDraftKey[mutation.draftKey];
  if (!latest) return false;
  const acknowledgedFields = new Set(result.acknowledgedFields);
  const acknowledged = (ledger.acknowledgedByDraftKey[mutation.draftKey] ??=
    {});
  let changed = false;
  for (const field of rememberComposerDefaultsFields) {
    const requested = mutation.fields[field];
    if (
      !requested ||
      !acknowledgedFields.has(field) ||
      latest[field] !== requested.generation
    ) {
      continue;
    }
    acknowledged[field] = {
      ...requested,
      confirmationReadsRemaining: composerDefaultsConfirmationReadLimit
    };
    changed = true;
  }
  return changed;
}

export function prepareAcknowledgedComposerDefaultsAuthorityRead(
  ledger: AgentGUIComposerDefaultsLedger,
  draftKey: string,
  settings: AgentSessionComposerSettings
): AgentGUIComposerDefaultsAuthorityRead {
  const authoritySettings = { ...settings };
  const receipt: AgentGUIComposerDefaultsAuthorityReadReceipt = {
    draftKey,
    fields: {}
  };
  const latest = ledger.latestByDraftKey[draftKey];
  const acknowledged = ledger.acknowledgedByDraftKey[draftKey];
  if (latest && acknowledged) {
    for (const field of rememberComposerDefaultsFields) {
      const entry = acknowledged[field];
      if (
        entry &&
        latest[field] === entry.generation &&
        normalizedComposerDefaultValue(authoritySettings, field) === entry.value
      ) {
        receipt.fields[field] = {
          generation: entry.generation,
          value: entry.value
        };
        delete authoritySettings[field];
      }
    }
  }
  const hasAcknowledgedFields = Object.keys(receipt.fields).length > 0;
  return {
    // An acknowledged field must cross the authority boundary again before
    // its optimistic draft can retire. Bypass a potentially pre-ack cache.
    force: hasAcknowledgedFields,
    receipt: hasAcknowledgedFields ? receipt : null,
    settings: authoritySettings
  };
}

export function retireAcknowledgedComposerDefaultsForRead(
  ledger: AgentGUIComposerDefaultsLedger,
  receipt: AgentGUIComposerDefaultsAuthorityReadReceipt,
  settings: AgentSessionComposerSettings,
  authoritativeSettings: AgentSessionComposerSettings
): AgentGUIRetiredComposerDefault[] {
  const latest = ledger.latestByDraftKey[receipt.draftKey];
  const acknowledged = ledger.acknowledgedByDraftKey[receipt.draftKey];
  if (!latest || !acknowledged) return [];
  const retired: AgentGUIRetiredComposerDefault[] = [];
  for (const field of rememberComposerDefaultsFields) {
    const readEntry = receipt.fields[field];
    const currentEntry = acknowledged[field];
    if (
      !readEntry ||
      !currentEntry ||
      currentEntry.generation !== readEntry.generation ||
      latest[field] !== readEntry.generation
    ) {
      continue;
    }
    const authoritativeValue = normalizedComposerDefaultValue(
      authoritativeSettings,
      field
    );
    if (authoritativeValue === null) {
      // This provider does not project authority for the field. Stop forcing
      // uncached reads, but keep the optimistic draft as the user's intent.
      delete acknowledged[field];
      continue;
    }
    if (authoritativeValue !== readEntry.value) {
      // A concrete different value can be a stale overlapping discovery.
      // Bound retries because some providers normalize or reject defaults and
      // never echo the requested value. Protect the optimistic intent during
      // confirmation, then release the marker so later settled options can
      // apply normal sanitization and reuse the Engine cache.
      currentEntry.confirmationReadsRemaining -= 1;
      if (currentEntry.confirmationReadsRemaining <= 0) {
        delete acknowledged[field];
      }
      continue;
    }
    if (normalizedComposerDefaultValue(settings, field) === readEntry.value) {
      retired.push({ field, value: readEntry.value });
    }
    delete acknowledged[field];
  }
  if (Object.keys(acknowledged).length === 0) {
    delete ledger.acknowledgedByDraftKey[receipt.draftKey];
  }
  return retired;
}

export function removeRetiredComposerDefaults(
  settings: AgentSessionComposerSettings,
  retired: readonly AgentGUIRetiredComposerDefault[]
): AgentSessionComposerSettings {
  const result = { ...settings };
  for (const entry of retired) {
    if (normalizedComposerDefaultValue(result, entry.field) === entry.value) {
      delete result[entry.field];
    }
  }
  return result;
}

export function preserveAcknowledgedComposerDefaultsForReconciliation(
  ledger: AgentGUIComposerDefaultsLedger,
  draftKey: string,
  currentSettings: AgentSessionComposerSettings,
  reconciledSettings: AgentSessionComposerSettings
): AgentSessionComposerSettings {
  const latest = ledger.latestByDraftKey[draftKey];
  const acknowledged = ledger.acknowledgedByDraftKey[draftKey];
  if (!latest || !acknowledged) return reconciledSettings;

  let result = reconciledSettings;
  for (const field of rememberComposerDefaultsFields) {
    const entry = acknowledged[field];
    if (
      !entry ||
      latest[field] !== entry.generation ||
      normalizedComposerDefaultValue(currentSettings, field) !== entry.value ||
      normalizedComposerDefaultValue(result, field) === entry.value
    ) {
      continue;
    }
    if (result === reconciledSettings) {
      result = { ...reconciledSettings };
    }
    Object.assign(result, { [field]: currentSettings[field] });
  }
  return result;
}
