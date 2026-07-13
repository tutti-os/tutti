export function downloadImage(src: string, name: string): void {
  const link = document.createElement("a");
  link.href = src;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

export function resolveImageDownloadName(
  name: string | undefined,
  src: string | null,
  alt: string | undefined
): string {
  const semanticName =
    resolveImageNameBase(name) ??
    resolveImageNameBase(alt) ??
    resolveImageNameBase(src) ??
    "image";
  const extension =
    resolveImageNameExtension(name) ??
    resolveImageNameExtension(src) ??
    resolveDataImageExtension(src) ??
    "png";
  return `${semanticName}-${formatImageDownloadTimestamp(new Date())}-${createDownloadRandomSuffix()}.${extension}`;
}

function resolveImageNameBase(value: string | null | undefined): string | null {
  const segment = imageNameSegment(value);
  if (!segment) {
    return null;
  }
  const base = segment.replace(/\.[A-Za-z0-9]{2,8}$/u, "");
  const sanitized = stripControlCharacters(base)
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]+/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
  return sanitized || null;
}

function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 32)
    .join("");
}

function resolveImageNameExtension(
  value: string | null | undefined
): string | null {
  const segment = imageNameSegment(value);
  const match = segment?.match(/\.([A-Za-z0-9]{2,8})$/u);
  return match?.[1] ? normalizeImageExtension(match[1]) : null;
}

function imageNameSegment(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const withoutQuery = decodeURIComponentSafe(
    trimmed.split(/[?#]/, 1)[0] ?? ""
  );
  return withoutQuery.split(/[\\/]/).pop()?.trim() || null;
}

function resolveDataImageExtension(src: string | null): string | null {
  const match = src?.match(/^data:image\/([A-Za-z0-9.+-]+)[;,]/u);
  return match?.[1] ? normalizeImageExtension(match[1]) : null;
}

function normalizeImageExtension(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === "jpeg") return "jpg";
  if (normalized === "svg+xml") return "svg";
  return normalized.replace(/[^a-z0-9]/gu, "") || "png";
}

function formatImageDownloadTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createDownloadRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
