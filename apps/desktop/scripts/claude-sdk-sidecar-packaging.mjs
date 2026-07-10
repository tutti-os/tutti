import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export const DARWIN_CLAUDE_NATIVE_PACKAGES = [
  {
    name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    lipoArch: "arm64"
  },
  {
    name: "@anthropic-ai/claude-agent-sdk-darwin-x64",
    lipoArch: "x86_64"
  }
];

export function resolveDarwinClaudeNativePackageSpecs(agentSdkPackage) {
  const optionalDependencies = agentSdkPackage.optionalDependencies ?? {};
  return DARWIN_CLAUDE_NATIVE_PACKAGES.map(({ name }) => {
    const version = optionalDependencies[name];
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(
        `Claude Agent SDK does not declare required optional dependency: ${name}`
      );
    }
    return `${name}@${version}`;
  });
}

export function resolveDarwinClaudeNativePackagesForPackContext(context) {
  // electron-builder creates both architecture-specific temporary apps before
  // merging a universal app. Their file lists must stay identical, so both
  // native packages are required in those intermediates.
  if (/-universal-(?:x64|arm64)-temp$/.test(context.appOutDir)) {
    return DARWIN_CLAUDE_NATIVE_PACKAGES;
  }

  // AfterPackContext.arch uses builder-util's numeric Arch enum.
  switch (context.arch) {
    case 1:
    case "x64":
      return DARWIN_CLAUDE_NATIVE_PACKAGES.filter(({ name }) =>
        name.endsWith("-x64")
      );
    case 3:
    case "arm64":
      return DARWIN_CLAUDE_NATIVE_PACKAGES.filter(({ name }) =>
        name.endsWith("-arm64")
      );
    case 4:
    case "universal":
      return DARWIN_CLAUDE_NATIVE_PACKAGES;
    default:
      throw new Error(
        `unsupported macOS package architecture: ${context.arch}`
      );
  }
}

export function pruneDarwinClaudeNativePackages(
  nodeModulesDir,
  packagesToKeep
) {
  const keep = new Set(packagesToKeep.map(({ name }) => name));
  for (const { name } of DARWIN_CLAUDE_NATIVE_PACKAGES) {
    if (!keep.has(name)) {
      rmSync(join(nodeModulesDir, name), { recursive: true, force: true });
    }
  }
}

export function verifyDarwinClaudeNativePackages(
  nodeModulesDir,
  packagesToVerify = DARWIN_CLAUDE_NATIVE_PACKAGES
) {
  for (const { name, lipoArch } of packagesToVerify) {
    const binary = join(nodeModulesDir, name, "claude");
    if (!existsSync(binary)) {
      throw new Error(`vendored Claude native binary missing: ${binary}`);
    }
    try {
      execFileSync("lipo", [binary, "-verify_arch", lipoArch], {
        stdio: "pipe"
      });
    } catch (error) {
      throw new Error(
        `vendored Claude native binary does not contain ${lipoArch}: ${binary}`,
        { cause: error }
      );
    }
  }
}
