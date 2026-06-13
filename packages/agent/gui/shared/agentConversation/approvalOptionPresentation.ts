import { translate } from "../../i18n/index";

export interface ApprovalOptionVisualPresentation {
  label: string;
  commandPrefix?: string;
}

export function approvalOptionDisplayLabel(
  option: {
    id: string;
    kind: string;
    label: string;
  },
  intent: { feedback?: boolean } = {}
): string {
  const idToken = normalizeApprovalOptionToken(option.id);
  const kindToken = normalizeApprovalOptionToken(option.kind);
  const label = option.label.trim();
  const specificTranslationKey = approvalOptionSpecificTranslationKey(
    idToken,
    label,
    intent
  );
  if (specificTranslationKey) {
    return translate(specificTranslationKey);
  }
  const providerLabelTranslation =
    approvalOptionProviderLabelTranslation(label);
  if (providerLabelTranslation) {
    return translate(
      providerLabelTranslation.key,
      providerLabelTranslation.params
    );
  }
  if (
    (idToken === "allowonce" || kindToken === "allowonce") &&
    isGenericAllowOnceLabel(label)
  ) {
    return translate("agentHost.agentGui.approvalOptions.allowOnce");
  }
  if (
    (idToken === "allowalways" ||
      idToken === "allowall" ||
      kindToken === "allowalways") &&
    isGenericApprovalLabel(label)
  ) {
    return translate("agentHost.agentGui.approvalOptions.allowAlways");
  }
  if (idToken === "rejectalways" || kindToken === "rejectalways") {
    return translate("agentHost.agentGui.approvalOptions.rejectAlways");
  }
  if (
    idToken === "rejectonce" ||
    idToken === "reject" ||
    idToken === "deny" ||
    kindToken === "rejectonce" ||
    kindToken === "reject" ||
    kindToken === "deny"
  ) {
    return intent.feedback
      ? translate("agentHost.agentGui.approvalOptions.rejectWithFollowUp")
      : translate("agentHost.agentGui.approvalOptions.rejectOnce");
  }
  return label || option.id;
}

export function approvalOptionVisualPresentation(
  option: {
    id: string;
    kind: string;
    label: string;
  },
  intent: { feedback?: boolean } = {}
): ApprovalOptionVisualPresentation {
  const commandPrefix = approvalOptionCommandPrefix(option.label);
  if (commandPrefix) {
    return {
      label: translate(
        "agentHost.agentGui.approvalOptions.allowAlwaysForCommandPrefixLead"
      ),
      commandPrefix
    };
  }
  return {
    label: approvalOptionDisplayLabel(option, intent)
  };
}

export function normalizeApprovalOptionToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function approvalOptionSpecificTranslationKey(
  token: string,
  label: string,
  intent: { feedback?: boolean } = {}
): string | null {
  const labelToken = normalizeApprovalOptionToken(label);
  switch (token) {
    case "approved":
      return isGenericAllowOnceLabel(label)
        ? "agentHost.agentGui.approvalOptions.allowOnce"
        : null;
    case "approvedforsession":
      return labelToken === "allowforthissession"
        ? "agentHost.agentGui.approvalOptions.allowForSession"
        : null;
    case "approvedalways":
      return isGenericApprovalLabel(label)
        ? "agentHost.agentGui.approvalOptions.allowAlways"
        : null;
    case "bypasspermissions":
      return "agentHost.agentGui.approvalOptions.bypassPermissions";
    case "auto":
      return labelToken === "yesanduseautomode"
        ? "agentHost.agentGui.approvalOptions.autoMode"
        : null;
    case "acceptedits":
      return "agentHost.agentGui.approvalOptions.acceptEdits";
    case "default":
      return labelToken === "yesandmanuallyapproveedits"
        ? "agentHost.agentGui.approvalOptions.manualApproval"
        : null;
    case "cancel":
      return !intent.feedback && labelToken === "cancel"
        ? "common.cancel"
        : null;
    default:
      return null;
  }
}

function approvalOptionProviderLabelTranslation(
  label: string
): { key: string; params: Record<string, string> } | null {
  const commandPrefix = approvalOptionCommandPrefix(label);
  if (commandPrefix) {
    return {
      key: "agentHost.agentGui.approvalOptions.allowAlwaysForCommandPrefix",
      params: { command: commandPrefix }
    };
  }

  const allowScopeMatch = label.match(/^Yes,\s*and don't ask again for (.+)$/i);
  if (allowScopeMatch?.[1]) {
    return {
      key: "agentHost.agentGui.approvalOptions.allowAlwaysForScope",
      params: { scope: allowScopeMatch[1] }
    };
  }

  const alwaysAllowMatch = label.match(/^Always Allow\s+(.+)$/i);
  if (alwaysAllowMatch?.[1]) {
    return {
      key: "agentHost.agentGui.approvalOptions.alwaysAllowScope",
      params: { scope: alwaysAllowMatch[1] }
    };
  }

  return null;
}

function approvalOptionCommandPrefix(label: string): string | null {
  const commandPrefixMatch = label.match(
    /^Yes,\s*and don't ask again for commands that start with `([^`]+)`$/i
  );
  return commandPrefixMatch?.[1]?.trim() || null;
}

function isGenericApprovalLabel(label: string): boolean {
  const token = normalizeApprovalOptionToken(label);
  return (
    token === "" ||
    token === "allowalways" ||
    token === "allowall" ||
    token === "alwaysallow" ||
    token === "allowanddontaskagain" ||
    token === "yesanddontaskagain"
  );
}

function isGenericAllowOnceLabel(label: string): boolean {
  const token = normalizeApprovalOptionToken(label);
  return (
    token === "" ||
    token === "allow" ||
    token === "allowonce" ||
    token === "yes" ||
    token === "yesproceed" ||
    token === "yesandproceed"
  );
}
