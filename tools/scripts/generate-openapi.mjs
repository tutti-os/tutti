import { createClient } from "@hey-api/openapi-ts";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const specPath = resolve(
  repoRoot,
  "services/tuttid/api/openapi/tuttid.v1.yaml"
);
const fragmentExtensionKey = "x-tutti-openapi-fragments";
const goTypesConfigPath = resolve(
  repoRoot,
  "services/tuttid/api/openapi/oapi-codegen.types.yaml"
);
const goServerConfigPath = resolve(
  repoRoot,
  "services/tuttid/api/openapi/oapi-codegen.server.yaml"
);
const goTypesOutputPath = resolve(
  repoRoot,
  "services/tuttid/api/generated/types.gen.go"
);
const goServerOutputPath = resolve(
  repoRoot,
  "services/tuttid/api/generated/server.gen.go"
);
const tsOutputDir = resolve(
  repoRoot,
  "packages/clients/tuttid-ts/src/generated"
);
const prettierConfigPath = resolve(
  repoRoot,
  "packages/configs/prettier/base.mjs"
);
const checkOnly = process.argv.includes("--check");

syncWorkbenchOpenApiSchema();

const scratchRoot = mkdtempSync(join(tmpdir(), "tutti-openapi-"));

try {
  const composedSpecPath = resolve(scratchRoot, "tuttid.v1.composed.yaml");
  const goTypesScratchPath = resolve(scratchRoot, "go/types.gen.go");
  const goServerScratchPath = resolve(scratchRoot, "go/server.gen.go");
  const tsScratchDir = resolve(scratchRoot, "ts");
  const tsSpecPath = resolve(scratchRoot, "ts/tuttid-ts-spec.yaml");

  writeComposedOpenAPISpec(composedSpecPath);
  generateGo(goTypesConfigPath, goTypesScratchPath, composedSpecPath);
  generateGo(goServerConfigPath, goServerScratchPath, composedSpecPath);
  hardenGeneratedGoServer(goServerScratchPath);
  writeTypeScriptSpec(tsSpecPath, composedSpecPath);
  await generateTypeScript(tsScratchDir, tsSpecPath);

  writeGeneratedFile(
    goTypesOutputPath,
    readFileSync(goTypesScratchPath, "utf8")
  );
  writeGeneratedFile(
    goServerOutputPath,
    readFileSync(goServerScratchPath, "utf8")
  );
  writeGeneratedDirectory(tsOutputDir, tsScratchDir);
} finally {
  rmSync(scratchRoot, { force: true, recursive: true });
}

function generateGo(configPath, outputPath, inputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync(
    "go",
    [
      "tool",
      "oapi-codegen",
      "-config",
      configPath,
      "-o",
      outputPath,
      inputPath
    ],
    {
      cwd: resolve(repoRoot, "services/tuttid"),
      stdio: "inherit"
    }
  );
}

function writeComposedOpenAPISpec(outputPath) {
  const document = YAML.parse(readFileSync(specPath, "utf8"));
  const fragmentRefs = normalizeFragmentRefs(document?.[fragmentExtensionKey]);
  delete document[fragmentExtensionKey];

  for (const fragmentRef of fragmentRefs) {
    const fragmentPath = resolveOpenApiFragmentPath(fragmentRef);
    const fragment = YAML.parse(readFileSync(fragmentPath, "utf8"));
    mergeOpenApiFragment(document, fragment, fragmentPath);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, YAML.stringify(document), "utf8");
}

function normalizeFragmentRefs(value) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fragmentExtensionKey} must be an array`);
  }
  return value.map((entry) => {
    const fragmentRef = String(entry ?? "").trim();
    if (fragmentRef === "") {
      throw new Error(`${fragmentExtensionKey} cannot contain empty entries`);
    }
    return fragmentRef;
  });
}

function resolveOpenApiFragmentPath(fragmentRef) {
  if (fragmentRef.startsWith(".")) {
    return resolve(dirname(specPath), fragmentRef);
  }
  return resolve(repoRoot, fragmentRef);
}

function mergeOpenApiFragment(document, fragment, fragmentPath) {
  mergeTags(document, fragment, fragmentPath);
  mergeMapSection(document, fragment, "paths", fragmentPath);

  const fragmentComponents = fragment?.components;
  if (
    fragmentComponents &&
    typeof fragmentComponents === "object" &&
    !Array.isArray(fragmentComponents)
  ) {
    document.components ??= {};
    for (const componentSection of Object.keys(fragmentComponents)) {
      mergeMapSection(
        document.components,
        fragmentComponents,
        componentSection,
        fragmentPath
      );
    }
  }
}

function mergeTags(document, fragment, fragmentPath) {
  if (!Array.isArray(fragment?.tags) || fragment.tags.length === 0) {
    return;
  }

  document.tags ??= [];
  const existingNames = new Set(
    document.tags
      .map((tag) => (tag && typeof tag === "object" ? tag.name : ""))
      .filter(Boolean)
  );
  for (const tag of fragment.tags) {
    if (!tag || typeof tag !== "object" || !tag.name) {
      throw new Error(`Invalid OpenAPI tag in ${fragmentPath}`);
    }
    if (existingNames.has(tag.name)) {
      continue;
    }
    document.tags.push(tag);
    existingNames.add(tag.name);
  }
}

function mergeMapSection(
  targetParent,
  sourceParent,
  sectionName,
  fragmentPath
) {
  const source = sourceParent?.[sectionName];
  if (!source) {
    return;
  }
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new Error(
      `OpenAPI section ${sectionName} in ${fragmentPath} must be an object`
    );
  }

  targetParent[sectionName] ??= {};
  const target = targetParent[sectionName];
  for (const [key, value] of Object.entries(source)) {
    if (target[key] == null) {
      target[key] = value;
      continue;
    }
    mergeOpenApiObject(
      target[key],
      value,
      `${sectionName}.${key}`,
      fragmentPath
    );
  }
}

function mergeOpenApiObject(target, source, location, fragmentPath) {
  if (Array.isArray(target) || Array.isArray(source)) {
    if (
      location.endsWith(".enum") &&
      Array.isArray(target) &&
      Array.isArray(source)
    ) {
      const seen = new Set(target);
      for (const value of source) {
        if (!seen.has(value)) {
          target.push(value);
          seen.add(value);
        }
      }
      return;
    }
    if (JSON.stringify(target) === JSON.stringify(source)) {
      return;
    }
    throw new Error(
      `Conflicting OpenAPI array at ${location} from ${fragmentPath}`
    );
  }

  if (!isPlainObject(target) || !isPlainObject(source)) {
    if (target === source) {
      return;
    }
    throw new Error(
      `Conflicting OpenAPI value at ${location} from ${fragmentPath}`
    );
  }

  for (const [key, value] of Object.entries(source)) {
    const childLocation = `${location}.${key}`;
    if (target[key] == null) {
      target[key] = value;
      continue;
    }
    mergeOpenApiObject(target[key], value, childLocation, fragmentPath);
  }
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hardenGeneratedGoServer(outputPath) {
  const source = readFileSync(outputPath, "utf8");
  const decodePattern =
    "\tif err := json.NewDecoder(r.Body).Decode(&body); err != nil {\n";
  const strictDecode = [
    "\tdecoder := json.NewDecoder(r.Body)\n",
    "\tdecoder.DisallowUnknownFields()\n",
    "\tif err := decoder.Decode(&body); err != nil {\n"
  ].join("");
  const hardened = source.replaceAll(decodePattern, strictDecode);

  if (hardened === source) {
    throw new Error(
      `Generated Go server decode hardening did not find any JSON body decoders in ${outputPath}`
    );
  }

  writeFileSync(outputPath, hardened, "utf8");
}

function syncWorkbenchOpenApiSchema() {
  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "tools/scripts/sync-workbench-openapi-schema.mjs"),
      ...(checkOnly ? ["--check"] : [])
    ],
    {
      cwd: repoRoot,
      stdio: "inherit"
    }
  );
}

async function generateTypeScript(outputDir, inputPath) {
  mkdirSync(outputDir, { recursive: true });

  await createClient({
    input: inputPath,
    output: outputDir,
    plugins: [
      {
        name: "@hey-api/typescript"
      },
      {
        name: "@hey-api/client-fetch"
      },
      {
        name: "@hey-api/sdk",
        client: "@hey-api/client-fetch",
        operations: "flat",
        paramsStructure: "grouped",
        responseStyle: "fields"
      }
    ]
  });

  for (const entry of listDirectoryEntries(outputDir)) {
    if (!entry.endsWith(".ts")) {
      continue;
    }

    const filePath = resolve(outputDir, entry);
    const source = readFileSync(filePath, "utf8");
    const normalized = source.replaceAll(
      /((?:from|export\s+\*\s+from)\s+['"])(\.[^'"]+)(['"])/g,
      (_match, prefix, specifier, suffix) => {
        if (
          specifier.endsWith(".ts") ||
          specifier.endsWith(".js") ||
          specifier.endsWith(".json")
        ) {
          return `${prefix}${specifier}${suffix}`;
        }

        const siblingFile = resolve(dirname(filePath), `${specifier}.ts`);
        if (existsSync(siblingFile)) {
          return `${prefix}${specifier}.ts${suffix}`;
        }

        const siblingIndex = resolve(dirname(filePath), specifier, "index.ts");
        if (existsSync(siblingIndex)) {
          return `${prefix}${specifier}/index.ts${suffix}`;
        }

        return `${prefix}${specifier}.ts${suffix}`;
      }
    );
    if (normalized !== source) {
      writeFileSync(filePath, normalized, "utf8");
    }
  }

  formatGeneratedTypeScript(outputDir);
}

function writeTypeScriptSpec(outputPath, inputPath) {
  const document = YAML.parse(readFileSync(inputPath, "utf8"));
  if (
    document?.paths &&
    typeof document.paths === "object" &&
    !Array.isArray(document.paths)
  ) {
    delete document.paths[
      "/v1/workspaces/{workspaceID}/terminals/{terminalID}/ws"
    ];
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, YAML.stringify(document), "utf8");
}

function formatGeneratedTypeScript(outputDir) {
  const tsFiles = listDirectoryEntries(outputDir)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => resolve(outputDir, entry));

  if (tsFiles.length === 0) {
    return;
  }

  execFileSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "prettier", "--write", "--config", prettierConfigPath, ...tsFiles],
    {
      cwd: repoRoot,
      stdio: "inherit"
    }
  );
}

function writeGeneratedFile(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true });

  if (checkOnly) {
    const existing = readExistingText(targetPath);
    if (existing !== content) {
      throw new Error(`Generated API artifacts are out of date: ${targetPath}`);
    }
    return;
  }

  writeFileSync(targetPath, content, "utf8");
}

function writeGeneratedDirectory(targetDir, sourceDir) {
  if (checkOnly) {
    compareDirectories(targetDir, sourceDir);
    return;
  }

  rmSync(targetDir, { force: true, recursive: true });
  mkdirSync(dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
}

function compareDirectories(targetDir, sourceDir) {
  const targetEntries = listDirectoryEntries(targetDir);
  const sourceEntries = listDirectoryEntries(sourceDir);
  const sourceSet = new Set(sourceEntries);

  for (const entry of targetEntries) {
    if (!sourceSet.has(entry)) {
      throw new Error(
        `Generated API artifacts are out of date: unexpected file ${join(targetDir, entry)}`
      );
    }
  }

  for (const entry of sourceEntries) {
    const targetPath = resolve(targetDir, entry);
    const sourcePath = resolve(sourceDir, entry);

    if (!targetEntries.includes(entry)) {
      throw new Error(
        `Generated API artifacts are out of date: missing file ${targetPath}`
      );
    }

    const targetContent = readExistingText(targetPath);
    const sourceContent = readFileSync(sourcePath, "utf8");
    if (targetContent !== sourceContent) {
      throw new Error(`Generated API artifacts are out of date: ${targetPath}`);
    }
  }
}

function listDirectoryEntries(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }

  return walk(rootDir, rootDir).sort();
}

function walk(rootDir, currentDir) {
  const entries = [];

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = resolve(currentDir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...walk(rootDir, fullPath));
      continue;
    }
    entries.push(relative(rootDir, fullPath));
  }

  return entries;
}

function readExistingText(path) {
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf8");
}
