const cssPresentationHintProperties = new Set([
  "animation",
  "animation-iteration-count",
  "backface-visibility",
  "transform",
  "will-change"
]);

const presentationSchedulerPattern =
  /\b(?:requestAnimationFrame|requestIdleCallback)\s*\(|\bnew\s+ResizeObserver\s*\(/g;
const inlineCompositorHintPattern = /\bwillChange\s*:|translate(?:3d|Z)\s*\(/g;
const presentationWorkReasonPattern =
  /(?:\/\/|\/\*|\*)\s*presentation-work:\s*\S/;

export const agentGuiPresentationStylesheet =
  "packages/agent/gui/app/renderer/agentactivity.css";

export const requiredAgentGuiPresentationDeclarations = [
  {
    property: "animation-play-state",
    selector:
      '.agent-gui-node__layout[data-agent-gui-visible="false"] :where(*,*::before,*::after)',
    value: "paused !important"
  },
  {
    property: "content-visibility",
    selector: '.agent-gui-node__layout[data-agent-gui-visible="false"]',
    value: "hidden"
  },
  {
    property: "animation",
    selector:
      '.agent-gui-node__layout[data-agent-gui-active="false"] .agent-gui-node__composer-prompt-tip-track,.agent-gui-node__layout[data-agent-gui-active="false"] .agent-gui-node__composer-prompt-tip-item',
    value: "none"
  },
  {
    property: "will-change",
    selector:
      '.agent-gui-node__layout[data-agent-gui-active="false"] .agent-gui-node__composer-prompt-tip-track,.agent-gui-node__layout[data-agent-gui-active="false"] .agent-gui-node__composer-prompt-tip-item',
    value: "auto"
  }
];

export function countPresentationSchedulers(source) {
  return countMatches(
    maskJavaScriptCommentsAndStrings(source),
    () => new RegExp(presentationSchedulerPattern.source, "g")
  );
}

export function countInlineCompositorHints(source) {
  return countMatches(
    maskJavaScriptComments(source),
    () => new RegExp(inlineCompositorHintPattern.source, "g")
  );
}

export function isPresentationSchedulerLine(sourceLine) {
  return new RegExp(presentationSchedulerPattern.source).test(sourceLine);
}

export function isInlineCompositorHintLine(sourceLine) {
  return new RegExp(inlineCompositorHintPattern.source).test(sourceLine);
}

export function hasPresentationWorkReason(contentLines, lineNumber) {
  const line = contentLines[lineNumber - 1] ?? "";
  const previousLine = contentLines[lineNumber - 2] ?? "";
  return (
    presentationWorkReasonPattern.test(line) ||
    presentationWorkReasonPattern.test(previousLine)
  );
}

export function analyzeAgentGuiPresentationCss(relativePath, source) {
  const declarations = parseCssDeclarations(source);
  const hints = [];
  const violations = [];

  for (const declaration of declarations) {
    if (isForbiddenTransitionAll(declaration)) {
      violations.push({
        line: declaration.line,
        message:
          "`transition: all` is forbidden on AgentGUI surfaces; name the properties that actually animate",
        rule: "no-transition-all"
      });
    }
    if (!isPresentationHint(declaration)) {
      continue;
    }
    const fingerprint = presentationHintFingerprint(relativePath, declaration);
    hints.push({ ...declaration, fingerprint });
  }

  const missingRequiredDeclarations =
    relativePath === agentGuiPresentationStylesheet
      ? findMissingRequiredDeclarations(declarations)
      : [];

  return { hints, missingRequiredDeclarations, violations };
}

export function presentationHintFingerprint(relativePath, declaration) {
  return `${relativePath} | ${declaration.selector} | ${declaration.property}: ${declaration.value}`;
}

export function validatePresentationHintReasons(hints, reasons) {
  const hintFingerprints = new Set(hints.map((hint) => hint.fingerprint));
  const missing = [...hintFingerprints]
    .filter((fingerprint) => {
      const reason = reasons[fingerprint];
      return typeof reason !== "string" || reason.trim().length === 0;
    })
    .sort();
  const stale = Object.keys(reasons)
    .filter((fingerprint) => !hintFingerprints.has(fingerprint))
    .sort();
  return { missing, stale };
}

function findMissingRequiredDeclarations(declarations) {
  return requiredAgentGuiPresentationDeclarations.filter(
    (required) =>
      !declarations.some(
        (declaration) =>
          declaration.selector === required.selector &&
          declaration.property === required.property &&
          declaration.value === required.value
      )
  );
}

function isForbiddenTransitionAll({ property, value }) {
  if (property === "transition-property") {
    return value
      .split(",")
      .some((candidate) => candidate.trim().toLowerCase() === "all");
  }
  if (property !== "transition") {
    return false;
  }
  return value.split(",").some((candidate) => {
    const firstToken = candidate.trim().split(/\s+/, 1)[0]?.toLowerCase();
    return firstToken === "all";
  });
}

function isPresentationHint({ property, value }) {
  if (!cssPresentationHintProperties.has(property)) {
    return false;
  }
  const normalizedValue = value.toLowerCase();
  if (property === "will-change") {
    return normalizedValue !== "auto";
  }
  if (property === "transform") {
    return /translate(?:3d|z)\s*\(/i.test(value);
  }
  if (property === "backface-visibility") {
    return normalizedValue === "hidden";
  }
  if (property === "animation-iteration-count") {
    return normalizedValue
      .split(",")
      .some((candidate) => candidate.trim() === "infinite");
  }
  return property === "animation" && /\binfinite\b/i.test(value);
}

function parseCssDeclarations(source) {
  const maskedSource = maskCssComments(source);
  const declarations = [];
  const blockPattern = /([^{}]+)\{([^{}]*)\}/g;

  for (const match of maskedSource.matchAll(blockPattern)) {
    const rawSelector = match[1] ?? "";
    const rawBody = match[2] ?? "";
    const selector = normalizeCssFragment(rawSelector);
    if (shouldSkipCssBlock(selector)) {
      continue;
    }
    const bodyStart = (match.index ?? 0) + rawSelector.length + 1;
    const declarationPattern = /(?:^|;)\s*([\w-]+)\s*:\s*([^;{}]+)/g;
    for (const declarationMatch of rawBody.matchAll(declarationPattern)) {
      const property = (declarationMatch[1] ?? "").toLowerCase();
      const value = normalizeCssFragment(declarationMatch[2] ?? "");
      if (!property || !value) {
        continue;
      }
      const declarationStart =
        bodyStart +
        (declarationMatch.index ?? 0) +
        (declarationMatch[0]?.indexOf(property) ?? 0);
      declarations.push({
        line: lineNumberAt(source, declarationStart),
        property,
        selector,
        value
      });
    }
  }
  return declarations;
}

function shouldSkipCssBlock(selector) {
  return (
    selector.startsWith("@") ||
    selector === "from" ||
    selector === "to" ||
    /^(?:\d+(?:\.\d+)?%)(?:\s*,\s*\d+(?:\.\d+)?%)*$/.test(selector)
  );
}

function normalizeCssFragment(value) {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s*([>,+~])\s*/g, "$1")
    .trim();
}

function maskCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " ")
  );
}

function maskJavaScriptCommentsAndStrings(source) {
  let result = "";
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", cursor);
      const stop = end === -1 ? source.length : end;
      result += " ".repeat(stop - cursor);
      cursor = stop;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      const stop = end === -1 ? source.length : end + 2;
      result += source.slice(cursor, stop).replace(/[^\n]/g, " ");
      cursor = stop;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const start = cursor;
      cursor += 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (source[cursor] === character) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      result += source.slice(start, cursor).replace(/[^\n]/g, " ");
      continue;
    }
    result += character;
    cursor += 1;
  }
  return result;
}

function maskJavaScriptComments(source) {
  let result = "";
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", cursor);
      const stop = end === -1 ? source.length : end;
      result += " ".repeat(stop - cursor);
      cursor = stop;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      const stop = end === -1 ? source.length : end + 2;
      result += source.slice(cursor, stop).replace(/[^\n]/g, " ");
      cursor = stop;
      continue;
    }
    result += character;
    cursor += 1;
  }
  return result;
}

function countMatches(source, patternFactory) {
  let count = 0;
  for (const _match of source.matchAll(patternFactory())) {
    count += 1;
  }
  return count;
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}
