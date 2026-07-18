import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

const MAX_CHROME_PROFILE_AVATAR_BYTES = 2 * 1024 * 1024;
const CHROME_PROFILE_AVATAR_FILES = [
  "Google Profile Picture.png",
  "Avatar.png"
] as const;

export async function readChromeProfileAvatarDataUrl(
  profilePath: string
): Promise<string | null> {
  for (const fileName of CHROME_PROFILE_AVATAR_FILES) {
    const avatar = await readSafeAvatar(join(profilePath, fileName));
    if (avatar) {
      return avatar;
    }
  }
  return null;
}

async function readSafeAvatar(path: string): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      stat.size > MAX_CHROME_PROFILE_AVATAR_BYTES
    ) {
      return null;
    }
    const bytes = await handle.readFile();
    const mimeType = imageMimeType(bytes);
    return mimeType
      ? `data:${mimeType};base64,${bytes.toString("base64")}`
      : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function imageMimeType(bytes: Buffer): "image/jpeg" | "image/png" | null {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    ? "image/jpeg"
    : null;
}
