import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const requiredFiles = [
  "components.json",
  "jsconfig.json",
  "public/styles.css",
  "public/assets/apps-agent.mp4",
  "public/assets/apps-example.webp",
  "public/assets/apps-overview.webp",
  "public/assets/apps-output-reference.webp",
  "public/assets/agent-gui-unconnected.webp",
  "public/assets/at-chat.webp",
  "public/assets/at-file.webp",
  "public/assets/at-task.webp",
  "public/assets/at-app.webp",
  "public/assets/apps-overview.webp",
  "public/assets/apps-example.webp",
  "public/assets/apps-example-prototype.webp",
  "public/assets/apps-example-docs.webp",
  "public/assets/at-app.webp",
  "public/assets/at-chat.webp",
  "public/assets/at-file.webp",
  "public/assets/at-task.webp",
  "public/assets/bind-claude.webp",
  "public/assets/bind-codex.webp",
  "public/assets/control-overview.webp",
  "public/assets/control-overview.webp",
  "public/assets/control-waiting.webp",
  "public/assets/goal-breakdown.webp",
  "public/assets/goal-breakdown.webp",
  "public/assets/window-layout.mp4",
  "public/assets/icon-window-layout.png",
  "public/assets/goal-run.webp",
  "public/assets/goal-set.webp",
  "public/assets/icon-clipboard.png",
  "public/assets/icon-electric-plug.png",
  "public/assets/icon-joystick.png",
  "public/assets/icon-satellite-antenna.png",
  "public/assets/icon-toolbox.png",
  "public/assets/logo1.png",
  "public/assets/tone-light.png",
  "public/icon.webp",
  "src/App.jsx",
  "src/main.jsx",
  "src/styles.css",
  "src/components/ui/button.jsx",
  "src/i18n/app-context.js",
  "src/i18n/index.js",
  "src/i18n/locales/en-US/onboarding.json",
  "src/i18n/locales/zh-CN/onboarding.json",
  "src/lib/utils.js",
  "tutti-package/tutti.app.json",
  "tutti-package/tutti.cli.json",
  "tutti-package/tutti-guide.md",
  "tutti-package/bootstrap.sh",
  "tutti-package/icon.webp",
  "tutti-package/server.go"
];

await Promise.all(
  requiredFiles.map((file) => access(path.join(appRoot, file)))
);

const indexHtml = await readFile(path.join(appRoot, "index.html"), "utf8");
if (!indexHtml.includes("Tutti · Getting Started")) {
  throw new Error("index.html must match the built-in onboarding entrypoint.");
}
if (/\p{Script=Han}/u.test(indexHtml)) {
  throw new Error("index.html must not hard-code Chinese copy.");
}

const appSource = await readFile(path.join(appRoot, "src/App.jsx"), "utf8");
const appContextSource = await readFile(
  path.join(appRoot, "src/i18n/app-context.js"),
  "utf8"
);
assertNoHardCodedChinese({
  "src/App.jsx": appSource,
  "src/i18n/app-context.js": appContextSource
});
assertHostContextApi(appContextSource);
await assertShadcnFoundation();

const translations = await readTranslations();
assertLocaleKeys(translations);
assertReferencedTranslationKeys(appSource, translations);

const manifest = JSON.parse(
  await readFile(path.join(appRoot, "tutti-package/tutti.app.json"), "utf8")
);
if (
  manifest.name !== "Getting Started" ||
  manifest.runtime?.healthcheckPath !== "/healthz" ||
  manifest.runtime?.profile !== "standalone" ||
  manifest.cli?.manifest !== "tutti.cli.json"
) {
  throw new Error(
    "tutti.app.json must match the built-in onboarding manifest."
  );
}
await assertCliManifest();
await assertManifestLocalizations(manifest);

console.log("tutti-onboarding assets are present");

function assertNoHardCodedChinese(sources) {
  for (const [file, source] of Object.entries(sources)) {
    if (/\p{Script=Han}/u.test(source)) {
      throw new Error(`${file} must not hard-code Chinese copy.`);
    }
  }
}

function assertHostContextApi(source) {
  if (!source.includes("tuttiExternal?.app")) {
    throw new Error("React app must read the Tutti host app context.");
  }
  if (source.includes("window.tutti") || source.includes("tuttiAppContext")) {
    throw new Error("React app must not use legacy Tutti globals.");
  }
  if (!source.includes("getContext") || !source.includes("subscribe")) {
    throw new Error(
      "React app must use tuttiExternal.app.getContext/subscribe for locale."
    );
  }
}

async function assertShadcnFoundation() {
  const componentsConfig = JSON.parse(
    await readFile(path.join(appRoot, "components.json"), "utf8")
  );
  if (
    componentsConfig.tailwind?.css !== "src/styles.css" ||
    componentsConfig.aliases?.ui !== "@/components/ui" ||
    componentsConfig.iconLibrary !== "lucide"
  ) {
    throw new Error("components.json must configure shadcn for this app.");
  }

  const mainSource = await readFile(path.join(appRoot, "src/main.jsx"), "utf8");
  if (!mainSource.includes('import "./styles.css";')) {
    throw new Error("src/main.jsx must import the Tailwind/shadcn CSS entry.");
  }

  const tailwindSource = await readFile(
    path.join(appRoot, "src/styles.css"),
    "utf8"
  );
  for (const required of [
    '@import "tailwindcss/theme.css"',
    '@import "tailwindcss/utilities.css"',
    '@import "shadcn/tailwind.css"'
  ]) {
    if (!tailwindSource.includes(required)) {
      throw new Error(`src/styles.css must include ${required}.`);
    }
  }

  const buttonSource = await readFile(
    path.join(appRoot, "src/components/ui/button.jsx"),
    "utf8"
  );
  if (
    !buttonSource.includes("buttonVariants") ||
    !buttonSource.includes("@radix-ui/react-slot")
  ) {
    throw new Error("shadcn Button foundation must be present.");
  }
}

async function assertCliManifest() {
  const cliManifest = JSON.parse(
    await readFile(path.join(appRoot, "tutti-package/tutti.cli.json"), "utf8")
  );
  if (
    cliManifest.schemaVersion !== "tutti.app.cli.v1" ||
    cliManifest.scope !== "onboarding" ||
    cliManifest.commands?.[0]?.path?.join(" ") !== "read"
  ) {
    throw new Error("tutti.cli.json must expose onboarding read.");
  }
  const guide = await readFile(
    path.join(appRoot, "tutti-package/tutti-guide.md"),
    "utf8"
  );
  if (!guide.includes("# Tutti 产品知识库")) {
    throw new Error("tutti-guide.md must contain the Tutti guide.");
  }
}

async function assertManifestLocalizations(manifest) {
  const info = manifest.localizationInfo;
  if (!info) {
    throw new Error("tutti.app.json must declare localizationInfo.");
  }
  if (info.defaultLocale !== "en") {
    throw new Error("tutti.app.json defaultLocale must match the source app.");
  }
  for (const locale of info.additionalLocales ?? []) {
    const localeManifest = JSON.parse(
      await readFile(path.join(appRoot, "tutti-package", locale.file), "utf8")
    );
    for (const key of ["name", "description", "tags"]) {
      if (!(key in localeManifest)) {
        throw new Error(`${locale.file} must define ${key}.`);
      }
    }
    if (!Array.isArray(localeManifest.tags)) {
      throw new Error(`${locale.file} tags must be an array.`);
    }
  }
}

async function readTranslations() {
  const translations = {
    "en-US": JSON.parse(
      await readFile(
        path.join(appRoot, "src/i18n/locales/en-US/onboarding.json"),
        "utf8"
      )
    ),
    "zh-CN": JSON.parse(
      await readFile(
        path.join(appRoot, "src/i18n/locales/zh-CN/onboarding.json"),
        "utf8"
      )
    )
  };

  if (!translations["zh-CN"].t_title.includes("新手指引")) {
    throw new Error("zh-CN onboarding copy must be preserved.");
  }

  return translations;
}

function assertLocaleKeys(translations) {
  const zhKeys = Object.keys(translations["zh-CN"]).sort();
  const enKeys = Object.keys(translations["en-US"]).sort();
  const missingInEn = zhKeys.filter((key) => !enKeys.includes(key));
  const missingInZh = enKeys.filter((key) => !zhKeys.includes(key));
  if (missingInEn.length || missingInZh.length) {
    throw new Error(
      [
        "zh/en translation keys must match.",
        missingInEn.length ? `Missing in en: ${missingInEn.join(", ")}` : "",
        missingInZh.length ? `Missing in zh: ${missingInZh.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join(" ")
    );
  }
}

function assertReferencedTranslationKeys(source, translations) {
  const referencedKeys = new Set(["t_doc_title", "t_soon"]);
  for (const match of source.matchAll(/t\("([^"]+)"\)/g)) {
    referencedKeys.add(match[1]);
  }
  for (const match of source.matchAll(/i18nKey="([^"]+)"/g)) {
    referencedKeys.add(match[1]);
  }
  for (const match of source.matchAll(/(?:altKey|labelKey): "([^"]+)"/g)) {
    referencedKeys.add(match[1]);
  }
  for (const locale of ["zh-CN", "en-US"]) {
    const missing = [...referencedKeys].filter(
      (key) => !(key in translations[locale])
    );
    if (missing.length) {
      throw new Error(
        `${locale} translations are missing referenced keys: ${missing.join(", ")}`
      );
    }
  }
}
