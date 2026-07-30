export interface KimiConfigProjection {
  defaultModel: string;
  modelProviders: Map<string, string>;
  providerBaseUrls: Map<string, string>;
  providerOAuthHosts: Map<string, string>;
  providerOAuthKeys: Map<string, string>;
}

/**
 * Read only the non-secret Kimi config fields needed to choose the active
 * billing mode. This intentionally does not materialize provider API keys.
 */
export function projectKimiConfig(content: string): KimiConfigProjection {
  const projection: KimiConfigProjection = {
    defaultModel: "",
    modelProviders: new Map(),
    providerBaseUrls: new Map(),
    providerOAuthHosts: new Map(),
    providerOAuthKeys: new Map()
  };
  let section: string[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = parseTomlPath(line.slice(1, -1).trim());
      continue;
    }
    const assignment = splitTomlAssignment(line);
    if (!assignment) continue;
    if (
      section[0] === "providers" &&
      section.length === 2 &&
      section[1] &&
      assignment.key === "oauth"
    ) {
      const inlineKey = inlineTomlString(assignment.value, "key");
      const inlineHost = inlineTomlString(assignment.value, "oauth_host");
      if (inlineKey) projection.providerOAuthKeys.set(section[1], inlineKey);
      if (inlineHost) projection.providerOAuthHosts.set(section[1], inlineHost);
      continue;
    }
    const value = parseTomlString(assignment.value);
    if (value === null) continue;
    if (section.length === 0 && assignment.key === "default_model") {
      projection.defaultModel = value;
      continue;
    }
    if (section[0] === "models" && section.length === 2) {
      if (assignment.key === "provider") {
        projection.modelProviders.set(section[1] ?? "", value);
      }
      continue;
    }
    if (section[0] !== "providers" || !section[1]) continue;
    const provider = section[1];
    if (section.length === 2 && assignment.key === "base_url") {
      projection.providerBaseUrls.set(provider, value);
    } else if (
      section.length === 3 &&
      section[2] === "oauth" &&
      assignment.key === "key"
    ) {
      projection.providerOAuthKeys.set(provider, value);
    } else if (
      section.length === 3 &&
      section[2] === "oauth" &&
      assignment.key === "oauth_host"
    ) {
      projection.providerOAuthHosts.set(provider, value);
    }
  }
  return projection;
}

export function kimiTokenStorageName(oauthKey: string): string | null {
  const key = oauthKey.trim();
  const name = key.startsWith("oauth/") ? key.slice(6) : key;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) ? name : null;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}

function parseTomlPath(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index <= value.length; index += 1) {
    const char = value[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
    } else if (quote === "'") {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "." || index === value.length) {
      const part = value.slice(start, index).trim();
      const decoded = parseTomlString(part);
      parts.push(decoded ?? part);
      start = index + 1;
    }
  }
  return parts;
}

function splitTomlAssignment(
  line: string
): { key: string; value: string } | null {
  const index = line.indexOf("=");
  if (index <= 0) return null;
  return {
    key: line.slice(0, index).trim(),
    value: line.slice(index + 1).trim()
  };
}

function parseTomlString(value: string): string | null {
  if (value.length < 2) return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return null;
}

function inlineTomlString(value: string, key: string): string {
  const match = new RegExp(
    `(?:^|[,{}])\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')`,
    "u"
  ).exec(value);
  return match ? (parseTomlString(match[1] ?? "") ?? "") : "";
}
