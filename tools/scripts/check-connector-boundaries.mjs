import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot =
  process.env.TUTTI_WORKSPACE_ROOT ?? resolve(scriptDirectory, "../..");

const rules = [
  {
    label: "Contracts depends on Renderer",
    root: "packages/connector/contracts",
    patterns: [
      /@tutti-os\/connector-renderer\b/u,
      /packages\/connector\/renderer/u
    ]
  },
  {
    label: "Renderer Application depends on UI or a host runtime",
    root: "packages/connector/renderer/src/application",
    patterns: [
      /(?:^|["'])\.\.\/ui\//mu,
      /@tutti-os\/connector-renderer\/ui\b/u,
      /(?:from\s*|import\s*)["'](?:react|react-dom|electron)(?:\/[^"']*)?["']/u,
      /@tutti-os\/agent-gui\b/u,
      /@renderer\//u,
      /apps\/desktop/u,
      /\b(?:document|localStorage|sessionStorage|window)\b/u
    ]
  },
  {
    label: "Connector package depends on a product owner",
    root: "packages/connector",
    patterns: [
      /@tutti-os\/agent-gui\b/u,
      /packages\/agent\/gui/u,
      /apps\/desktop/u,
      /services\/tuttid/u
    ]
  },
  {
    label: "Daemon Core depends on a concrete adapter",
    root: "packages/connector/daemon/core",
    patterns: [
      /packages\/connector\/daemon\/adapters\//u,
      /packages\/connector\/daemon\/application/u
    ]
  },
  {
    label: "Runtime depends on Daemon Application or a concrete adapter",
    root: "packages/connector/runtime",
    patterns: [
      /packages\/connector\/daemon\/application/u,
      /packages\/connector\/daemon\/adapters\/(?:controlplane|sqlite)/u
    ]
  }
];

const violations = [];
for (const rule of rules) {
  const absoluteRoot = resolve(workspaceRoot, rule.root);
  if (!existsSync(absoluteRoot)) {
    continue;
  }
  for (const filePath of walk(absoluteRoot)) {
    if (!isSourceFile(filePath)) {
      continue;
    }
    const source = readFileSync(filePath, "utf8");
    for (const pattern of rule.patterns) {
      const match = pattern.exec(source);
      if (!match) {
        continue;
      }
      violations.push({
        file: relative(workspaceRoot, filePath).replaceAll("\\", "/"),
        label: rule.label,
        line: lineNumber(source, match.index)
      });
    }
  }
}

const rendererManifestPath = resolve(
  workspaceRoot,
  "packages/connector/renderer/package.json"
);
if (existsSync(rendererManifestPath)) {
  const manifest = JSON.parse(readFileSync(rendererManifestPath, "utf8"));
  if (Object.hasOwn(manifest.exports ?? {}, ".")) {
    violations.push({
      file: "packages/connector/renderer/package.json",
      label: "Renderer exposes a root barrel",
      line: 1
    });
  }
}

if (violations.length > 0) {
  process.stderr.write(
    "Connector ownership boundaries were violated:\n" +
      violations
        .map(
          (violation) =>
            `- ${violation.file}:${violation.line} ${violation.label}`
        )
        .join("\n") +
      "\n"
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Connector ownership boundary check passed\n");
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === "dist" ||
      entry.name === "node_modules" ||
      entry.name.startsWith(".")
    ) {
      continue;
    }
    const filePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(filePath);
    } else {
      yield filePath;
    }
  }
}

function isSourceFile(filePath) {
  return /\.(?:go|js|jsx|mjs|ts|tsx)$/u.test(filePath);
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}
