export type AvatarAssetSize = 32 | 48 | 64 | 96 | 128 | 256 | 512;
export type EmojiAssetSize = 32 | 48 | 64 | 96 | 128 | 256;
export type ContentAssetWidth = 320 | 640 | 1280 | 1920;
export type AssetOutputFormat = "webp";

export type AssetVariant =
  | { kind: "avatar"; size: AvatarAssetSize; format?: AssetOutputFormat }
  | { kind: "emoji"; size: EmojiAssetSize; format?: AssetOutputFormat }
  | { kind: "image"; width: ContentAssetWidth; format?: AssetOutputFormat };

const IMAGE_QUERY_NAMES = ["width", "height", "fit", "format"] as const;

export function buildAssetUrl(baseUrl: string, variant?: AssetVariant): string {
  const trimmed = baseUrl.trim();
  if (!trimmed || !variant) {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (
    url.origin !== "https://assets.tutti.sh" ||
    !url.pathname.startsWith("/v1/assets/")
  ) {
    return trimmed;
  }
  for (const name of IMAGE_QUERY_NAMES) {
    url.searchParams.delete(name);
  }
  if (variant.kind === "image") {
    url.searchParams.set("width", String(variant.width));
    url.searchParams.set("fit", "scale-down");
  } else {
    url.searchParams.set("width", String(variant.size));
    url.searchParams.set("height", String(variant.size));
    url.searchParams.set(
      "fit",
      variant.kind === "avatar" ? "cover" : "contain"
    );
  }
  if (variant.format) {
    url.searchParams.set("format", variant.format);
  }
  return url.toString();
}
