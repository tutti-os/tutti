const prefixedProperty = "-webkit-backdrop-filter";
const standardProperty = "backdrop-filter";
const launchpadSelector = ".workspace-launchpad-overlay__dismiss";

export function analyzeBackdropFilterAuthoring({ path, source }) {
  const diagnostics = [];
  const pattern = /-webkit-backdrop-filter/giu;

  for (const match of source.matchAll(pattern)) {
    diagnostics.push(
      diagnosticAt({
        index: match.index,
        kind: "prefixed-authoring",
        message: `remove ${prefixedProperty}; author ${standardProperty} only`,
        path,
        source,
        token: prefixedProperty
      })
    );
  }

  return diagnostics;
}

export function analyzeBackdropFilterArtifact({ path, css }) {
  const diagnostics = [];
  const launchpadDeclarations = [];

  for (const block of collectCssBlocks(css)) {
    const declarations = collectBackdropFilterDeclarations(css, block);
    const prefixed = declarations.filter(
      (declaration) => declaration.property === prefixedProperty
    );
    const standard = declarations.filter(
      (declaration) => declaration.property === standardProperty
    );

    if (prefixed.length > 0 && standard.length === 0) {
      diagnostics.push(
        artifactDiagnostic({
          block,
          css,
          declaration: prefixed[0],
          kind: "prefix-only-artifact",
          message: `${prefixedProperty} must be followed by ${standardProperty} in the same declaration block`,
          path
        })
      );
    } else if (
      prefixed.length > 0 &&
      standard.at(-1).index < prefixed.at(-1).index
    ) {
      diagnostics.push(
        artifactDiagnostic({
          block,
          css,
          declaration: prefixed.at(-1),
          kind: "artifact-declaration-order",
          message: `${standardProperty} must appear after ${prefixedProperty} in the final CSS`,
          path
        })
      );
    }

    if (block.prelude.includes(launchpadSelector)) {
      launchpadDeclarations.push(
        ...standard.map((declaration) => ({
          path,
          selector: block.prelude,
          value: declaration.value
        }))
      );
    }
  }

  return { diagnostics, launchpadDeclarations };
}

export function analyzeBackdropFilterArtifacts(assets) {
  const diagnostics = [];
  const launchpadDeclarations = [];

  for (const asset of assets) {
    const result = analyzeBackdropFilterArtifact(asset);
    diagnostics.push(...result.diagnostics);
    launchpadDeclarations.push(...result.launchpadDeclarations);
  }

  if (
    !launchpadDeclarations.some(
      (declaration) =>
        !/^none(?:\s*!important)?$/iu.test(declaration.value.trim())
    )
  ) {
    diagnostics.push({
      column: 1,
      kind: "missing-launchpad-backdrop-filter",
      line: 1,
      message: `${launchpadSelector} must retain a non-none ${standardProperty} declaration`,
      path: assets[0]?.path ?? "<renderer-css>",
      selector: launchpadSelector,
      token: standardProperty
    });
  }

  return diagnostics;
}

export function isBackdropFilterAuthoringPath(path) {
  const normalized = path.replaceAll("\\", "/");
  if (!/^(?:apps|packages|services)\//u.test(normalized)) {
    return false;
  }
  if (
    /(?:^|\/)(?:coverage|dist|node_modules|out|\.tmp)(?:\/|$)/u.test(
      normalized
    ) ||
    /\.(?:spec|test)\.[^.]+$/u.test(normalized)
  ) {
    return false;
  }
  return /\.(?:cjs|css|cts|html|js|jsx|mjs|mts|ts|tsx)$/u.test(normalized);
}

function collectCssBlocks(css) {
  const blocks = [];
  const stack = [];
  let quote = null;
  let inComment = false;

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    const next = css[index + 1];

    if (inComment) {
      if (character === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") {
      const parent = stack.at(-1)?.blockIndex ?? null;
      const blockIndex = blocks.length;
      blocks.push({
        closeIndex: null,
        contentStart: index + 1,
        index,
        parent,
        prelude: readPrelude(css, index)
      });
      stack.push({ blockIndex });
      continue;
    }
    if (character === "}" && stack.length > 0) {
      const entry = stack.pop();
      blocks[entry.blockIndex].closeIndex = index;
    }
  }

  return blocks.filter((block) => block.closeIndex !== null);
}

function readPrelude(css, openIndex) {
  let start = openIndex - 1;
  while (start >= 0 && !"{};".includes(css[start])) {
    start -= 1;
  }
  return css
    .slice(start + 1, openIndex)
    .replace(/\s+/gu, " ")
    .trim();
}

function collectBackdropFilterDeclarations(css, block) {
  const content = css.slice(block.contentStart, block.closeIndex);
  const masked = maskCssNonCode(content);
  const declarations = [];
  const pattern =
    /(^|;)\s*(-webkit-backdrop-filter|backdrop-filter)\s*:\s*([^;{}]*)(?=;|$)/giu;

  for (const match of masked.matchAll(pattern)) {
    const propertyToken = match[2];
    const property = propertyToken.toLowerCase();
    const propertyOffset = match.index + match[0].indexOf(propertyToken);
    declarations.push({
      index: block.contentStart + propertyOffset,
      property,
      value: match[3].trim()
    });
  }

  return declarations;
}

function maskCssNonCode(source) {
  const characters = source.split("");
  let quote = null;
  let inComment = false;
  let depth = 0;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const next = characters[index + 1];

    if (inComment) {
      characters[index] = " ";
      if (character === "*" && next === "/") {
        characters[index + 1] = " ";
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      characters[index] = " ";
      if (character === "\\") {
        characters[index + 1] = " ";
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      inComment = true;
      index += 1;
      continue;
    }
    if (character === "\\") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      characters[index] = " ";
      quote = character;
      continue;
    }
    if (character === "{") {
      depth += 1;
      characters[index] = " ";
      continue;
    }
    if (character === "}") {
      depth = Math.max(0, depth - 1);
      characters[index] = " ";
      continue;
    }
    if (depth > 0) {
      characters[index] = " ";
    }
  }

  return characters.join("");
}

function artifactDiagnostic({ block, css, declaration, kind, message, path }) {
  return diagnosticAt({
    index: declaration.index,
    kind,
    message,
    path,
    selector: block.prelude || "<anonymous block>",
    source: css,
    token: declaration.property
  });
}

function diagnosticAt({ index, kind, message, path, selector, source, token }) {
  const prefix = source.slice(0, index);
  const lines = prefix.split("\n");
  return {
    column: lines.at(-1).length + 1,
    kind,
    line: lines.length,
    message,
    path,
    ...(selector ? { selector } : {}),
    token
  };
}
