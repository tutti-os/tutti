import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceGlobs = [
  "*.ts",
  "*.tsx",
  "!**/*.d.ts",
  "!**/*.test.*",
  "!**/*.spec.*",
  "!**/*.stories.*"
];

export async function resolveComponentSources(componentEntries, sourceRoot) {
  const root = resolve(sourceRoot);
  const entryCandidates = new Map(
    componentEntries.map((entry) => [
      entry.name,
      componentSymbolCandidates(entry.name)
    ])
  );
  const allCandidates = [
    ...new Set([...entryCandidates.values()].flat())
  ].sort();
  if (allCandidates.length === 0) {
    return componentEntries.map((entry) => ({ ...entry, source: null }));
  }

  const alternation = allCandidates.map(escapeRegex).join("|");
  const declarationPattern =
    `(?:function|class)\\s+(${alternation})\\b|` +
    `(?:const|let|var)\\s+(${alternation})\\s*[:=]`;
  const matches = await searchDeclarations(root, declarationPattern);
  const matchesBySymbol = new Map();
  const declarationRegex = new RegExp(declarationPattern, "u");

  for (const match of matches) {
    const declaration = declarationRegex.exec(match.text);
    const symbol = declaration?.[1] ?? declaration?.[2] ?? null;
    if (!symbol) continue;
    const values = matchesBySymbol.get(symbol) ?? [];
    values.push({
      file: relative(root, match.path),
      line: match.line,
      symbol
    });
    matchesBySymbol.set(symbol, values);
  }

  return componentEntries.map((entry) => {
    const candidates = entryCandidates.get(entry.name) ?? [];
    const locations = uniqueLocations(
      candidates.flatMap((candidate) => matchesBySymbol.get(candidate) ?? [])
    );
    const source =
      locations.length > 0 &&
      new Set(locations.map((location) => location.file)).size === 1
        ? locations[0]
        : null;
    return {
      ...entry,
      source: source ? { ...source, confidence: "static-declaration" } : null,
      sourceResolution:
        locations.length > 1 && !source
          ? { status: "ambiguous", candidateCount: locations.length }
          : locations.length === 0
            ? { status: "unresolved" }
            : { status: "resolved" }
    };
  });
}

export function componentSymbolCandidates(componentName) {
  const forwardRef = /^ForwardRef\((.+)\)$/u.exec(componentName.trim());
  const rawName = forwardRef?.[1] ?? componentName.trim();
  if (!/^[A-Z][A-Za-z0-9_$]*$/u.test(rawName)) return [];
  const candidates = [rawName];
  const withoutCompilerSuffix = rawName.replace(/\d+$/u, "");
  if (withoutCompilerSuffix && withoutCompilerSuffix !== rawName) {
    candidates.push(withoutCompilerSuffix);
  }
  return candidates;
}

async function searchDeclarations(root, pattern) {
  const args = ["--json", "--line-number"];
  for (const glob of sourceGlobs) args.push("--glob", glob);
  args.push(pattern, root);
  try {
    const { stdout } = await execFileAsync("rg", args, {
      maxBuffer: 4 * 1024 * 1024
    });
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "match")
      .map((event) => ({
        path: event.data.path.text,
        line: event.data.line_number,
        text: event.data.lines.text
      }));
  } catch (error) {
    if (error.code === 1) return [];
    if (error.code === "ENOENT") {
      return searchDeclarationsWithNode(root, pattern);
    }
    throw new Error(`component source lookup failed: ${error.message}`);
  }
}

async function searchDeclarationsWithNode(root, pattern) {
  const regex = new RegExp(pattern, "u");
  const matches = [];
  for (const path of await collectSourceFiles(root)) {
    const source = await readFile(path, "utf8");
    const lines = source.split(/\r?\n/u);
    lines.forEach((text, index) => {
      if (!regex.test(text)) return;
      matches.push({
        path,
        line: index + 1,
        text
      });
    });
  }
  return matches;
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(path)));
      continue;
    }
    if (!entry.isFile() || !isSearchableSourceFile(entry.name)) continue;
    files.push(path);
  }
  return files;
}

function isSearchableSourceFile(fileName) {
  return (
    /\.(?:ts|tsx)$/u.test(fileName) &&
    !fileName.endsWith('.d.ts') &&
    !/\.(?:test|spec|stories)\.[^.]+$/u.test(fileName)
  );
}

function uniqueLocations(locations) {
  const values = new Map();
  for (const location of locations) {
    values.set(
      `${location.file}:${location.line}:${location.symbol}`,
      location
    );
  }
  return [...values.values()].sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line
  );
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
