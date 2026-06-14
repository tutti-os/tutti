#!/usr/bin/env node

import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourcePackageRoot = resolve(scriptDirectory, "..", "..", "..");
const cwdRequire = createRequire(join(process.cwd(), "package.json"));
const packageRoot = await resolvePackageRoot(sourcePackageRoot);

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

if (!options.componentId) {
  throw new Error("--component-id is required");
}

if (!options.componentName) {
  throw new Error("--component-name is required");
}

if (!options.stateMatrixPath) {
  throw new Error("--state-matrix is required");
}

const componentId = normalizeComponentId(options.componentId);
const componentName = normalizeComponentName(options.componentName);
const serverUrl = options.serverUrl || "http://127.0.0.1:4100";
const outputDirectory = resolve(
  options.outDir || join(tmpdir(), `tutti-ui-system-preview-${componentId}`)
);
const stateMatrix = normalizeStateMatrix(
  JSON.parse(await readFile(resolve(options.stateMatrixPath), "utf8"))
);

await assertReadableDirectory(packageRoot);

if (await pathExists(outputDirectory)) {
  if (!options.force) {
    throw new Error(
      `Preview directory already exists: ${outputDirectory}\n` +
        "Run with --force to replace it."
    );
  }

  await rm(outputDirectory, { recursive: true, force: true });
}

await mkdir(join(outputDirectory, "src"), { recursive: true });

const files = new Map([
  ["package.json", packageJson(componentId)],
  ["index.html", indexHtml(componentName)],
  ["vite.config.ts", viteConfig(serverUrl)],
  ["tsconfig.json", tsconfigJson()],
  ["src/main.tsx", mainTsx()],
  ["src/Preview.tsx", previewTsx(componentName)],
  ["src/stateMatrix.ts", stateMatrixTs(stateMatrix)],
  ["src/style.css", styleCss()]
]);

await Promise.all(
  Array.from(files, ([relativePath, content]) =>
    writeFile(join(outputDirectory, relativePath), content)
  )
);

console.log(`Created preview scaffold at ${outputDirectory}`);
console.log("");
console.log("Run:");
console.log(`  cd ${outputDirectory}`);
console.log("  pnpm install");
console.log("  pnpm dev -- --host 127.0.0.1");
console.log("");
console.log("Before reviewing, make sure the UI-system dev server is running:");
console.log("  pnpm --filter @tutti-os/ui-system dev:server");
console.log(`  curl ${serverUrl}/health`);

function parseArgs(args) {
  const parsed = {
    componentId: "",
    componentName: "",
    force: false,
    help: false,
    outDir: "",
    serverUrl: "",
    stateMatrixPath: ""
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--force") {
      parsed.force = true;
      continue;
    }

    if (arg === "--component-id") {
      parsed.componentId = requireValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--component-name") {
      parsed.componentName = requireValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--state-matrix") {
      parsed.stateMatrixPath = requireValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--out-dir") {
      parsed.outDir = requireValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--server-url") {
      parsed.serverUrl = requireValue(args, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function requireValue(args, index, optionName) {
  const value = args[index + 1];

  if (!value) {
    throw new Error(`${optionName} requires a value`);
  }

  return value;
}

function printHelp() {
  console.log(`Usage: create-business-preview.mjs --component-id <id> --component-name <Name> --state-matrix <path> [options]

Generates a temporary Vite React preview scaffold for a proposed
@tutti-os/ui-system business component promotion.

Options:
  --component-id <id>      Stable kebab-case component id.
  --component-name <Name>  Proposed React export name.
  --state-matrix <path>    JSON file with an array of states or { "states": [] }.
  --out-dir <path>         Output directory. Defaults to $TMPDIR/tutti-ui-system-preview-<id>.
  --server-url <url>       UI-system dev server URL. Defaults to http://127.0.0.1:4100.
  --force                  Replace an existing output directory.
  -h, --help               Show this help message.

State matrix item fields:
  name, evidence, propsData, hostOwnedBehavior, includedInContract,
  description, boundaryNotes`);
}

function normalizeComponentId(value) {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  if (!normalized) {
    throw new Error(
      "Component id must contain at least one alphanumeric character"
    );
  }

  return normalized;
}

function normalizeComponentName(value) {
  const normalized = value.trim();

  if (!/^[A-Z][A-Za-z0-9]*$/.test(normalized)) {
    throw new Error(
      "--component-name must be a PascalCase React component name"
    );
  }

  return normalized;
}

function normalizeStateMatrix(value) {
  const states = Array.isArray(value) ? value : value?.states;

  if (!Array.isArray(states) || states.length === 0) {
    throw new Error(
      'State matrix must be a non-empty array or { "states": [] }'
    );
  }

  return states.map((state, index) => {
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      throw new Error(`State matrix item ${index + 1} must be an object`);
    }

    const name = stringField(state, "name", `state-${index + 1}`);

    return {
      name,
      evidence: stringListField(state, "evidence"),
      propsData: stringListField(state, "propsData"),
      hostOwnedBehavior: stringListField(state, "hostOwnedBehavior"),
      includedInContract: Boolean(state.includedInContract),
      description: stringField(state, "description", ""),
      boundaryNotes: stringListField(state, "boundaryNotes")
    };
  });
}

function stringField(object, field, fallback) {
  const value = object[field];

  if (typeof value === "string") {
    return value;
  }

  return fallback;
}

function stringListField(object, field) {
  const value = object[field];

  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === "string" && value.length > 0) {
    return [value];
  }

  return [];
}

async function assertReadableDirectory(path) {
  await access(path, constants.R_OK);
  const pathStats = await stat(path);

  if (!pathStats.isDirectory()) {
    throw new Error(`Expected directory: ${path}`);
  }
}

async function resolvePackageRoot(sourceCandidate) {
  if (await isUISystemPackageRoot(sourceCandidate)) {
    return sourceCandidate;
  }

  let entrypoint;

  try {
    entrypoint = cwdRequire.resolve("@tutti-os/ui-system");
  } catch {
    throw new Error(
      "Unable to resolve @tutti-os/ui-system. Run this from a Tutti checkout " +
        "or a project with @tutti-os/ui-system installed."
    );
  }

  const resolvedRoot = await findPackageRoot(dirname(entrypoint));

  if (resolvedRoot === null) {
    throw new Error(
      `Unable to find @tutti-os/ui-system package root from ${entrypoint}`
    );
  }

  return resolvedRoot;
}

async function isUISystemPackageRoot(candidate) {
  try {
    const packageJson = JSON.parse(
      await readFile(join(candidate, "package.json"), "utf8")
    );

    return packageJson.name === "@tutti-os/ui-system";
  } catch {
    return false;
  }
}

async function findPackageRoot(startDirectory) {
  let current = startDirectory;

  while (true) {
    if (await isUISystemPackageRoot(current)) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function packageJson(componentId) {
  return `${JSON.stringify(
    {
      name: `tutti-ui-system-preview-${componentId}`,
      private: true,
      type: "module",
      scripts: {
        dev: "vite",
        typecheck: "tsc --noEmit"
      },
      dependencies: {
        "@tutti-os/ui-system": `file:${packageRoot}`,
        "@vitejs/plugin-react": "^5.1.1",
        vite: "^6.4.2",
        typescript: "^5.8.3",
        react: "^19.1.0",
        "react-dom": "^19.1.0"
      },
      devDependencies: {
        "@types/react": "^19.1.6",
        "@types/react-dom": "^19.1.5"
      }
    },
    null,
    2
  )}\n`;
}

function indexHtml(componentName) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${componentName} Promotion Preview</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

function viteConfig(serverUrl) {
  return `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { tuttiUISystemDev } from "@tutti-os/ui-system/dev-vite";

export default defineConfig({
  plugins: [
    tuttiUISystemDev({ serverUrl: ${JSON.stringify(serverUrl)} }),
    react()
  ],
  server: {
    host: "127.0.0.1"
  }
});
`;
}

function tsconfigJson() {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        lib: ["DOM", "DOM.Iterable", "ES2022"],
        allowJs: false,
        skipLibCheck: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        strict: true,
        forceConsistentCasingInFileNames: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx"
      },
      include: ["src", "vite.config.ts"]
    },
    null,
    2
  )}\n`;
}

function mainTsx() {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Preview } from "./Preview";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
`;
}

function previewTsx(componentName) {
  return `import "@tutti-os/ui-system/styles.css";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@tutti-os/ui-system/components";

import { stateMatrix, type PreviewState } from "./stateMatrix";

type ${componentName}DraftProps = {
  state: PreviewState;
  onPrimaryAction?: (stateName: string) => void;
};

function ${componentName}Draft({
  state,
  onPrimaryAction = () => undefined
}: ${componentName}DraftProps) {
  return (
    <Card className="preview-draft">
      <CardHeader>
        <div className="preview-draft-header">
          <div>
            <CardTitle>{state.name}</CardTitle>
            <CardDescription>
              {state.description || "Draft visual surface for review."}
            </CardDescription>
          </div>
          <Badge variant={state.includedInContract ? "default" : "secondary"}>
            {state.includedInContract ? "in contract" : "excluded"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="preview-draft-body">
        <dl>
          <BoundaryRow label="Evidence" values={state.evidence} />
          <BoundaryRow label="Props/Data" values={state.propsData} />
          <BoundaryRow
            label="Host owned"
            values={state.hostOwnedBehavior}
          />
          <BoundaryRow label="Boundary notes" values={state.boundaryNotes} />
        </dl>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => onPrimaryAction(state.name)}
        >
          Draft callback
        </Button>
      </CardContent>
    </Card>
  );
}

function BoundaryRow({
  label,
  values
}: {
  label: string;
  values: string[];
}) {
  return (
    <div className="boundary-row">
      <dt>{label}</dt>
      <dd>{values.length > 0 ? values.join("; ") : "None recorded"}</dd>
    </div>
  );
}

export function Preview() {
  return (
    <main className="preview-shell">
      <header className="preview-header">
        <p className="preview-kicker">Tutti UI-system business promotion</p>
        <h1>${componentName} Preview</h1>
        <p>
          Review the state coverage, visual behavior, props boundary, and
          host-owned behavior before promoting this component into
          <code>@tutti-os/ui-system</code>.
        </p>
      </header>

      <section className="preview-grid">
        {stateMatrix.map((state) => (
          <${componentName}Draft
            key={state.name}
            state={state}
            onPrimaryAction={(stateName) => {
              console.log("Draft callback fired for", stateName);
            }}
          />
        ))}
      </section>
    </main>
  );
}
`;
}

function stateMatrixTs(stateMatrix) {
  return `export type PreviewState = {
  name: string;
  evidence: string[];
  propsData: string[];
  hostOwnedBehavior: string[];
  includedInContract: boolean;
  description: string;
  boundaryNotes: string[];
};

export const stateMatrix = ${JSON.stringify(stateMatrix, null, 2)} satisfies PreviewState[];
`;
}

function styleCss() {
  return `@source "../.tutti-ui-system-dev";

:root {
  color: hsl(var(--foreground));
  background: hsl(var(--background));
  font-family:
    ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
}

body {
  margin: 0;
  min-width: 320px;
}

code {
  border: 1px solid hsl(var(--border));
  border-radius: 4px;
  background: hsl(var(--muted));
  padding: 0.1rem 0.3rem;
}

.preview-shell {
  margin: 0 auto;
  max-width: 1180px;
  padding: 32px;
}

.preview-header {
  max-width: 760px;
  padding-bottom: 24px;
}

.preview-header h1 {
  margin: 0;
  font-size: 32px;
  line-height: 1.1;
}

.preview-header p {
  color: hsl(var(--muted-foreground));
}

.preview-kicker {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.preview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
}

.preview-draft {
  min-height: 100%;
}

.preview-draft-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.preview-draft-body {
  display: grid;
  gap: 16px;
}

.boundary-row {
  display: grid;
  gap: 4px;
  padding: 10px 0;
  border-top: 1px solid hsl(var(--border));
}

.boundary-row:first-child {
  border-top: 0;
  padding-top: 0;
}

.boundary-row dt {
  color: hsl(var(--muted-foreground));
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.boundary-row dd {
  margin: 0;
  color: hsl(var(--foreground));
  font-size: 13px;
}
`;
}
