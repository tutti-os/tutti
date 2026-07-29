import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const sourcePath = join(
  workspaceRoot,
  "packages/ui/system/src/tokens/renderer-theme.json"
);
const cssOutputPath = join(
  workspaceRoot,
  "packages/ui/system/src/styles/generated/renderer-theme.css"
);
const nativeOutputPath = join(
  workspaceRoot,
  "packages/ui/system/src/native/generated-tokens.ts"
);

const source = JSON.parse(await readFile(sourcePath, "utf8"));
validateSource(source);

const expectedOutputs = new Map([
  [cssOutputPath, renderCss(source)],
  [nativeOutputPath, renderNativeTokens(source)]
]);
const writeOutputs = process.argv.includes("--write");

if (writeOutputs) {
  await Promise.all(
    Array.from(expectedOutputs, ([path, output]) => writeFile(path, output))
  );
}

const stalePaths = [];

for (const [path, expected] of expectedOutputs) {
  const actual = await readFile(path, "utf8");
  if (actual !== expected) {
    stalePaths.push(path);
  }
}

if (stalePaths.length > 0) {
  console.error(
    "Renderer token outputs are stale. Update them from packages/ui/system/src/tokens/renderer-theme.json:"
  );
  for (const path of stalePaths) {
    console.error(`- ${path}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    writeOutputs
      ? "renderer token outputs generated"
      : "renderer token check passed"
  );
}

function validateSource(value) {
  if (value.schemaVersion !== 1) {
    throw new Error("renderer theme manifest must use schemaVersion 1");
  }

  for (const key of ["control", "radius", "space"]) {
    if (typeof value.dimensions?.[key] !== "object") {
      throw new Error(`renderer theme manifest is missing dimensions.${key}`);
    }
  }

  const lightKeys = Object.keys(value.themes?.light ?? {});
  const darkKeys = Object.keys(value.themes?.dark ?? {});
  if (lightKeys.length === 0 || lightKeys.join("|") !== darkKeys.join("|")) {
    throw new Error("light and dark renderer token keys must match");
  }

  for (const mode of ["light", "dark"]) {
    for (const key of lightKeys) {
      const token = value.themes[mode][key];
      if (typeof token?.native !== "string" || typeof token.web !== "string") {
        throw new Error(
          `renderer token ${mode}.${key} must define string native and web values`
        );
      }
    }
  }
}

function renderCss(value) {
  const light = renderCssThemeBlock(":root", value.themes.light);
  const dark = renderCssThemeBlock(
    ':root[data-theme="dark"]',
    value.themes.dark
  );
  const automaticDark = renderCssThemeBlock(
    ':root:not([data-theme="light"])',
    value.themes.dark,
    "  "
  );

  return [
    "/* This file is generated from ../tokens/renderer-theme.json. Do not edit it directly. */",
    light,
    "",
    dark,
    "",
    "@media (prefers-color-scheme: dark) {",
    automaticDark,
    "}",
    ""
  ].join("\n");
}

function renderCssThemeBlock(selector, theme, indent = "") {
  const declarations = Object.entries(theme).map(
    ([key, token]) => `${indent}  --renderer-${toKebabCase(key)}: ${token.web};`
  );
  return [`${indent}${selector} {`, ...declarations, `${indent}}`].join("\n");
}

function renderNativeTokens(value) {
  const nativeThemes = Object.fromEntries(
    Object.entries(value.themes).map(([mode, theme]) => [
      mode,
      Object.fromEntries(
        Object.entries(theme).map(([key, token]) => [key, token.native])
      )
    ])
  );

  return [
    "/* This file is generated from ../tokens/renderer-theme.json. Do not edit it directly. */",
    `export const nativeThemeDimensions = ${formatTypescriptObject(value.dimensions)} as const;`,
    "",
    `export const nativeThemes = ${formatTypescriptObject(nativeThemes)} as const;`,
    "",
    "export type NativeThemeMode = keyof typeof nativeThemes;",
    "export type NativeThemePalette = (typeof nativeThemes)[NativeThemeMode];",
    ""
  ].join("\n");
}

function formatTypescriptObject(value) {
  return JSON.stringify(value, null, 2).replace(
    /^(\s*)"([A-Za-z_$][A-Za-z0-9_$]*)":/gm,
    "$1$2:"
  );
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
