const forbiddenClassSubjects = [
  "agent-gui-conversation__assistant-message-flow",
  "agent-gui-conversation__user-message-flow",
  "agent-gui-node__body",
  "agent-gui-node__conversation-list",
  "agent-gui-node__detail",
  "agent-gui-node__detail-panel",
  "agent-gui-node__layout",
  "agent-gui-node__provider-rail-panel",
  "agent-gui-node__rail",
  "agent-gui-node__shell",
  "agent-gui-node__timeline",
  "agent-gui-node__timeline-with-composer",
  "agent-gui-transcript-row",
  "desktop-dock",
  "desktop-dock-plate",
  "workbench-surface",
  "workbench-window",
  "workbench-window-shell",
  "workspace-node-window",
  "workspace-node-window__body"
];

export function analyzeCssHasPerformance({ path, source }) {
  const diagnostics = [];
  const maskedSource = maskCssNonCode(source);

  for (const rule of collectCssRulePreludes(maskedSource)) {
    const hasPattern = /:has\s*\(/giu;
    for (const match of rule.prelude.matchAll(hasPattern)) {
      const compound = readSubjectCompound(rule.prelude.slice(0, match.index));
      const subject = findForbiddenSubject(compound);
      if (!subject) {
        continue;
      }

      diagnostics.push(
        diagnosticAt({
          index: rule.startIndex + match.index,
          message:
            `do not use :has() on large dynamic subject ${subject}; ` +
            "project the state onto the subject with a data attribute",
          path,
          selector: source
            .slice(rule.startIndex, rule.endIndex)
            .replace(/\s+/gu, " ")
            .trim(),
          source,
          subject
        })
      );
    }
  }

  return diagnostics;
}

export function isCssHasPerformancePath(path) {
  const normalized = path.replaceAll("\\", "/");
  return (
    /^(?:apps|packages|services)\//u.test(normalized) &&
    normalized.endsWith(".css") &&
    !/(?:^|\/)(?:coverage|dist|node_modules|out|\.tmp)(?:\/|$)/u.test(
      normalized
    ) &&
    !/(?:^|\/)[^/]+\.(?:spec|test)\.css$/u.test(normalized)
  );
}

function collectCssRulePreludes(maskedSource) {
  const rules = [];
  let statementStart = 0;

  for (let index = 0; index < maskedSource.length; index += 1) {
    const character = maskedSource[index];
    if (character === "{") {
      const statement = maskedSource.slice(statementStart, index);
      const firstCodeOffset = findFirstCodeOffset(statement);
      if (firstCodeOffset >= 0) {
        const startIndex = statementStart + firstCodeOffset;
        const prelude = maskedSource.slice(startIndex, index);
        if (!prelude.startsWith("@")) {
          rules.push({ endIndex: index, prelude, startIndex });
        }
      }
      statementStart = index + 1;
      continue;
    }
    if (character === "}" || character === ";") {
      statementStart = index + 1;
    }
  }

  return rules;
}

function readSubjectCompound(prefix) {
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let start = 0;

  for (let index = 0; index < prefix.length; index += 1) {
    const character = prefix[index];
    if (character === "\u0000") {
      continue;
    }
    if (character === "[") {
      bracketDepth += 1;
      continue;
    }
    if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (character === "(") {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ")") {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      continue;
    }
    if (bracketDepth > 0 || parenthesisDepth > 0) {
      continue;
    }
    if (
      character === "," ||
      character === ">" ||
      character === "+" ||
      character === "~"
    ) {
      start = index + 1;
      continue;
    }
    if (/\s/u.test(character)) {
      start = index + 1;
    }
  }

  return prefix.slice(start).trim();
}

function findForbiddenSubject(compound) {
  if (/^:root(?=[.#[:]|$)/u.test(compound)) {
    return ":root";
  }
  const typeSubject = /^(?:\*?\|)?(body|html)(?=[.#[:]|$)/u.exec(compound);
  if (typeSubject) {
    return typeSubject[1];
  }

  for (const className of forbiddenClassSubjects) {
    const pattern = new RegExp(
      `(?:^|[^a-zA-Z0-9_-])\\.${escapeRegExp(className)}(?![a-zA-Z0-9_-])`,
      "u"
    );
    if (pattern.test(compound)) {
      return `.${className}`;
    }
  }

  return null;
}

function maskCssNonCode(source) {
  const characters = source.split("");
  let inComment = false;
  let quote = null;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const next = characters[index + 1];
    if (inComment) {
      characters[index] = "\u0000";
      if (character === "*" && next === "/") {
        characters[index + 1] = "\u0000";
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character !== "\n") {
        characters[index] = " ";
      }
      if (character === "\\") {
        if (next !== "\n") {
          characters[index + 1] = " ";
        }
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      characters[index] = "\u0000";
      characters[index + 1] = "\u0000";
      inComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      characters[index] = " ";
      quote = character;
    }
  }

  return characters.join("");
}

function diagnosticAt({ index, message, path, selector, source, subject }) {
  const prefix = source.slice(0, index);
  const lines = prefix.split("\n");
  return {
    column: lines.at(-1).length + 1,
    kind: "large-dynamic-has-subject",
    line: lines.length,
    message,
    path,
    selector,
    subject,
    token: ":has"
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function findFirstCodeOffset(source) {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\u0000" && !/\s/u.test(source[index])) {
      return index;
    }
  }
  return -1;
}
