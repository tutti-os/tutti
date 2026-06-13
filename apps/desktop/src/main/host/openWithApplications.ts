import { shouldFilterVideoPlayersForOpenWith } from "@tutti-os/workspace-file-preview";
import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopOpenWithApplication } from "../../shared/contracts/ipc.ts";
import { resolveOpenWithApplicationIconOverrideDataUrl } from "../../shared/openWithApplicationIconOverrides.ts";

const execFileAsync = promisify(execFile);
type ExecFileAsync = (
  file: string,
  args?: readonly string[],
  options?: { maxBuffer?: number }
) => Promise<{ stderr: string; stdout: string }>;

const openWithApplicationsByCacheKey = new Map<
  string,
  DesktopOpenWithApplication[]
>();
const applicationIconDataUrlByPath = new Map<string, string | null>();
const defaultApplicationIconDataUrlByCacheKey = new Map<
  string,
  string | null
>();
let cachedListOpenWithApplicationsSwiftScriptPath: string | null = null;
let cachedOpenFileWithDefaultBrowserSwiftScriptPath: string | null = null;
let cachedReadApplicationIconSwiftScriptPath: string | null = null;
let cachedResolveDefaultApplicationSwiftScriptPath: string | null = null;

const videoPlayerApplicationPathPattern =
  /\/(QuickTime Player|QuickTime|TV|IINA|VLC|Elmedia Player|Movist|MPV|Fig Player|5KPlayer|NicePlayer)\.app$/i;
const videoPlayerApplicationNamePattern =
  /^(QuickTime Player|IINA|VLC|Elmedia Player|Movist|MPV|Fig Player|5KPlayer|NicePlayer)/i;
const openWithSwiftMaxBufferBytes = 64 * 1024 * 1024;

const listOpenWithApplicationsSwiftSource = `
import AppKit
import Foundation

func encodeApplicationIconBase64(for bundlePath: String) -> String {
    let workspace = NSWorkspace.shared
    let icon = workspace.icon(forFile: bundlePath)
    icon.size = NSSize(width: 32, height: 32)
    guard let tiff = icon.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        return ""
    }
    return png.base64EncodedString()
}

let targetPath = CommandLine.arguments[1]
let targetURL = URL(fileURLWithPath: targetPath)
let workspace = NSWorkspace.shared
let appURLs = workspace.urlsForApplications(toOpen: targetURL)
for appURL in appURLs {
    let bundlePath = appURL.path
    let name = FileManager.default.displayName(atPath: bundlePath)
    let bundleIdentifier = Bundle(url: appURL)?.bundleIdentifier ?? ""
    let iconBase64 = encodeApplicationIconBase64(for: bundlePath)
    print("\\(name)\\t\\(bundlePath)\\t\\(bundleIdentifier)\\t\\(iconBase64)")
}
`;

const readApplicationIconSwiftSource = `
import AppKit
import Foundation

let bundlePath = CommandLine.arguments[1]
let workspace = NSWorkspace.shared
let icon = workspace.icon(forFile: bundlePath)
icon.size = NSSize(width: 32, height: 32)
guard let tiff = icon.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    exit(1)
}
print(png.base64EncodedString())
`;

const resolveDefaultApplicationSwiftSource = `
import AppKit
import Foundation

let targetPath = CommandLine.arguments[1]
let targetURL = URL(fileURLWithPath: targetPath)
let workspace = NSWorkspace.shared
guard let appURL = workspace.urlForApplication(toOpen: targetURL) else {
    exit(1)
}
let bundlePath = appURL.path
let name = FileManager.default.displayName(atPath: bundlePath)
print("\\(name)\\t\\(bundlePath)")
`;

const openFileWithDefaultBrowserSwiftSource = `
import AppKit
import Foundation

let targetPath = CommandLine.arguments[1]
let targetURL = URL(fileURLWithPath: targetPath)
let workspace = NSWorkspace.shared
guard let probeURL = URL(string: "https://example.com/") else {
    exit(2)
}
guard let browserURL = workspace.urlForApplication(toOpen: probeURL) else {
    exit(3)
}
let semaphore = DispatchSemaphore(value: 0)
let configuration = NSWorkspace.OpenConfiguration()
workspace.open([targetURL], withApplicationAt: browserURL, configuration: configuration) { _, error in
    if error != nil {
        exit(4)
    }
    semaphore.signal()
}
if semaphore.wait(timeout: .now() + 10) == .timedOut {
    exit(5)
}
`;

export async function listOpenWithApplications(
  targetPath: string
): Promise<DesktopOpenWithApplication[]> {
  const normalizedPath = path.resolve(targetPath);
  accessSync(normalizedPath, constants.F_OK);

  if (process.platform !== "darwin") {
    return [];
  }

  const cacheKey = resolveOpenWithApplicationsCacheKey(normalizedPath);
  const cachedApplications = openWithApplicationsByCacheKey.get(cacheKey);
  if (cachedApplications) {
    return cachedApplications;
  }

  const { stdout } = await runListOpenWithApplicationsSwift(normalizedPath);

  const parsedApplications: DesktopOpenWithApplication[] = [];
  for (const line of stdout.split("\n")) {
    const parsedLine = parseListOpenWithApplicationsLine(line);
    if (!parsedLine) {
      continue;
    }
    parsedApplications.push(parsedLine);
  }

  const filteredParsedApplications = filterOpenWithApplications(
    parsedApplications,
    normalizedPath
  );
  const applications: DesktopOpenWithApplication[] = [];
  for (const application of filteredParsedApplications) {
    applications.push({
      applicationPath: application.applicationPath,
      bundleIdentifier: application.bundleIdentifier,
      iconDataUrl:
        application.iconDataUrl ??
        (await readApplicationIconDataUrl(
          application.applicationPath,
          application.name
        )),
      name: application.name
    });
  }
  openWithApplicationsByCacheKey.set(cacheKey, applications);
  return applications;
}

export function filterOpenWithApplications(
  applications: readonly DesktopOpenWithApplication[],
  targetPath: string
): DesktopOpenWithApplication[] {
  const seen = new Set<string>();
  const accessibleApplications: DesktopOpenWithApplication[] = [];
  for (const application of applications) {
    if (!canAccessApplication(application.applicationPath)) {
      continue;
    }

    const dedupeKey = resolveOpenWithApplicationDedupeKey(application);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    accessibleApplications.push(application);
  }

  if (!shouldFilterVideoPlayersForTarget(targetPath)) {
    return accessibleApplications;
  }

  return accessibleApplications.filter(
    (application) => !isVideoPlayerApplication(application)
  );
}

export async function openFileWithDefaultBrowser(
  targetPath: string,
  options: { execFile?: ExecFileAsync } = {}
): Promise<void> {
  const normalizedTargetPath = path.resolve(targetPath);
  accessSync(normalizedTargetPath, constants.F_OK);

  if (process.platform !== "darwin") {
    throw new Error("open with default browser is only supported on macOS");
  }

  const scriptPath = await resolveOpenFileWithDefaultBrowserSwiftScriptPath();
  await (options.execFile ?? execFileAsync)(
    "swift",
    [scriptPath, normalizedTargetPath],
    {
      maxBuffer: 10 * 1024 * 1024
    }
  );
}

export function resetOpenWithApplicationsCacheForTests(): void {
  openWithApplicationsByCacheKey.clear();
  applicationIconDataUrlByPath.clear();
  defaultApplicationIconDataUrlByCacheKey.clear();
  cachedListOpenWithApplicationsSwiftScriptPath = null;
  cachedOpenFileWithDefaultBrowserSwiftScriptPath = null;
  cachedReadApplicationIconSwiftScriptPath = null;
  cachedResolveDefaultApplicationSwiftScriptPath = null;
}

export function parseListOpenWithApplicationsLine(line: string): {
  applicationPath: string;
  bundleIdentifier: string | null;
  iconDataUrl: string | null;
  name: string;
} | null {
  if (!line.trim()) {
    return null;
  }

  const parts = line.replace(/\r$/, "").split("\t");
  if (parts.length < 2) {
    return null;
  }

  const name = parts[0]?.trim() ?? "";
  const applicationPath = parts[1]?.trim() ?? "";
  if (!name || !applicationPath) {
    return null;
  }

  const hasBundleIdentifierColumn = parts.length >= 4;
  const bundleIdentifier = hasBundleIdentifierColumn
    ? parts[2]?.trim() || null
    : null;
  const iconBase64 = parts[hasBundleIdentifierColumn ? 3 : 2]?.trim() ?? "";
  return {
    applicationPath,
    bundleIdentifier,
    iconDataUrl: iconBase64 ? `data:image/png;base64,${iconBase64}` : null,
    name
  };
}

function shouldFilterVideoPlayersForTarget(targetPath: string): boolean {
  return shouldFilterVideoPlayersForOpenWith({
    kind: "file",
    name: path.basename(targetPath),
    path: targetPath
  });
}

function isVideoPlayerApplication(
  application: Pick<DesktopOpenWithApplication, "applicationPath" | "name">
): boolean {
  return (
    videoPlayerApplicationPathPattern.test(application.applicationPath) ||
    videoPlayerApplicationNamePattern.test(application.name)
  );
}

function resolveOpenWithApplicationDedupeKey(
  application: Pick<
    DesktopOpenWithApplication,
    "applicationPath" | "bundleIdentifier"
  >
): string {
  return application.bundleIdentifier ?? application.applicationPath;
}

function canAccessApplication(applicationPath: string): boolean {
  try {
    accessSync(applicationPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOpenWithApplicationsCacheKey(targetPath: string): string {
  const extension = path.extname(targetPath).toLowerCase();
  return `v4:${extension.length > 0 ? extension : "(no-ext)"}`;
}

async function runListOpenWithApplicationsSwift(
  targetPath: string
): Promise<{ stdout: string }> {
  const scriptPath = await resolveListOpenWithApplicationsSwiftScriptPath();
  return execFileAsync("swift", [scriptPath, targetPath], {
    maxBuffer: openWithSwiftMaxBufferBytes
  });
}

async function resolveListOpenWithApplicationsSwiftScriptPath(): Promise<string> {
  if (cachedListOpenWithApplicationsSwiftScriptPath) {
    return cachedListOpenWithApplicationsSwiftScriptPath;
  }

  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "tutti-open-with-swift-")
  );
  const scriptPath = path.join(tempDirectory, "listOpenWithApplications.swift");
  await writeFile(scriptPath, listOpenWithApplicationsSwiftSource, "utf8");
  cachedListOpenWithApplicationsSwiftScriptPath = scriptPath;
  return scriptPath;
}

async function resolveOpenFileWithDefaultBrowserSwiftScriptPath(): Promise<string> {
  if (cachedOpenFileWithDefaultBrowserSwiftScriptPath) {
    return cachedOpenFileWithDefaultBrowserSwiftScriptPath;
  }

  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "tutti-open-with-default-browser-swift-")
  );
  const scriptPath = path.join(
    tempDirectory,
    "openFileWithDefaultBrowser.swift"
  );
  await writeFile(scriptPath, openFileWithDefaultBrowserSwiftSource, "utf8");
  cachedOpenFileWithDefaultBrowserSwiftScriptPath = scriptPath;
  return scriptPath;
}

export async function pickOpenWithApplication(
  prompt = "Choose an application:"
): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const escapedPrompt = escapeAppleScriptString(prompt);
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      `set chosenApp to choose application with prompt "${escapedPrompt}"\nreturn POSIX path of (path to chosenApp)`
    ]);
    const applicationPath = stdout.trim();
    if (!applicationPath) {
      return null;
    }
    accessSync(applicationPath, constants.F_OK);
    return applicationPath;
  } catch {
    return null;
  }
}

export async function openFileWithOtherApplication(
  targetPath: string,
  applicationPickerPrompt?: string
): Promise<void> {
  const normalizedTargetPath = path.resolve(targetPath);
  accessSync(normalizedTargetPath, constants.F_OK);

  const applicationPath = await pickOpenWithApplication(
    applicationPickerPrompt
  );
  if (!applicationPath) {
    return;
  }

  await openFileWithApplication(normalizedTargetPath, applicationPath);
}

export async function openFileWithApplication(
  targetPath: string,
  applicationPath: string,
  options: { execFile?: ExecFileAsync } = {}
): Promise<void> {
  const normalizedTargetPath = path.resolve(targetPath);
  const normalizedApplicationPath = path.resolve(applicationPath);
  accessSync(normalizedTargetPath, constants.F_OK);
  accessSync(normalizedApplicationPath, constants.F_OK);

  if (process.platform === "darwin") {
    await (options.execFile ?? execFileAsync)("open", [
      "-a",
      normalizedApplicationPath,
      normalizedTargetPath
    ]);
    return;
  }

  throw new Error("open with application is only supported on macOS");
}

export async function readApplicationIconDataUrl(
  applicationPath: string,
  applicationName: string
): Promise<string | null> {
  if (applicationIconDataUrlByPath.has(applicationPath)) {
    return applicationIconDataUrlByPath.get(applicationPath) ?? null;
  }

  const overrideIconDataUrl = resolveOpenWithApplicationIconOverrideDataUrl({
    applicationPath,
    name: applicationName
  });
  if (overrideIconDataUrl) {
    applicationIconDataUrlByPath.set(applicationPath, overrideIconDataUrl);
    return overrideIconDataUrl;
  }

  const iconPath = resolveApplicationIconPath(applicationPath);
  if (iconPath) {
    try {
      const { nativeImage } = await import("electron");
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) {
        const iconDataUrl = image.resize({ height: 32, width: 32 }).toDataURL();
        applicationIconDataUrlByPath.set(applicationPath, iconDataUrl);
        return iconDataUrl;
      }
    } catch {
      // Fall through to NSWorkspace icon lookup.
    }
  }

  const workspaceIconDataUrl =
    await readApplicationIconDataUrlFromWorkspace(applicationPath);
  applicationIconDataUrlByPath.set(applicationPath, workspaceIconDataUrl);
  return workspaceIconDataUrl;
}

export async function readDefaultApplicationIconDataUrl(
  targetPath: string
): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const normalizedTargetPath = path.resolve(targetPath);
  const cacheKey = resolveOpenWithApplicationsCacheKey(normalizedTargetPath);
  if (defaultApplicationIconDataUrlByCacheKey.has(cacheKey)) {
    return defaultApplicationIconDataUrlByCacheKey.get(cacheKey) ?? null;
  }

  try {
    const scriptPath = await resolveDefaultApplicationSwiftScriptPath();
    const { stdout } = await execFileAsync(
      "swift",
      [scriptPath, normalizedTargetPath],
      {
        maxBuffer: openWithSwiftMaxBufferBytes
      }
    );
    const application = parseDefaultApplicationLine(stdout);
    const iconDataUrl = application
      ? await readApplicationIconDataUrl(
          application.applicationPath,
          application.name
        )
      : null;
    defaultApplicationIconDataUrlByCacheKey.set(cacheKey, iconDataUrl);
    return iconDataUrl;
  } catch {
    defaultApplicationIconDataUrlByCacheKey.set(cacheKey, null);
    return null;
  }
}

function parseDefaultApplicationLine(line: string): {
  applicationPath: string;
  name: string;
} | null {
  const parsedLine = parseListOpenWithApplicationsLine(line);
  if (!parsedLine) {
    return null;
  }
  return {
    applicationPath: parsedLine.applicationPath,
    name: parsedLine.name
  };
}

async function readApplicationIconDataUrlFromWorkspace(
  applicationPath: string
): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const scriptPath = await resolveReadApplicationIconSwiftScriptPath();
    const { stdout } = await execFileAsync(
      "swift",
      [scriptPath, applicationPath],
      {
        maxBuffer: openWithSwiftMaxBufferBytes
      }
    );
    const iconBase64 = stdout.trim();
    if (!iconBase64) {
      return null;
    }
    return `data:image/png;base64,${iconBase64}`;
  } catch {
    return null;
  }
}

async function resolveReadApplicationIconSwiftScriptPath(): Promise<string> {
  if (cachedReadApplicationIconSwiftScriptPath) {
    return cachedReadApplicationIconSwiftScriptPath;
  }

  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "tutti-open-with-icon-swift-")
  );
  const scriptPath = path.join(tempDirectory, "readApplicationIcon.swift");
  await writeFile(scriptPath, readApplicationIconSwiftSource, "utf8");
  cachedReadApplicationIconSwiftScriptPath = scriptPath;
  return scriptPath;
}

async function resolveDefaultApplicationSwiftScriptPath(): Promise<string> {
  if (cachedResolveDefaultApplicationSwiftScriptPath) {
    return cachedResolveDefaultApplicationSwiftScriptPath;
  }

  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "tutti-default-app-swift-")
  );
  const scriptPath = path.join(
    tempDirectory,
    "resolveDefaultApplication.swift"
  );
  await writeFile(scriptPath, resolveDefaultApplicationSwiftSource, "utf8");
  cachedResolveDefaultApplicationSwiftScriptPath = scriptPath;
  return scriptPath;
}

function resolveApplicationIconPath(applicationPath: string): string | null {
  const resourcesDirectory = path.join(
    applicationPath,
    "Contents",
    "Resources"
  );
  for (const candidate of [
    "AppIcon.icns",
    "app.icns",
    "ApplicationIcon.icns",
    "icon.icns"
  ]) {
    const iconPath = path.join(resourcesDirectory, candidate);
    if (isReadableFile(iconPath)) {
      return iconPath;
    }
  }

  try {
    for (const entry of readdirSync(resourcesDirectory)) {
      if (!entry.endsWith(".icns")) {
        continue;
      }
      const iconPath = path.join(resourcesDirectory, entry);
      if (isReadableFile(iconPath)) {
        return iconPath;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function isReadableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
