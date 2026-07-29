import { ChromeIcon } from "@tutti-os/ui-system";
import type { JSX } from "react";
import type { BrowserNodeChromeProfile } from "../core/types.ts";
import { chromeProfileAvatarDataUrl } from "./chromeCookieImportUiModel.ts";

export function BrowserNodeChromeProfileAvatar({
  profile
}: {
  profile: BrowserNodeChromeProfile;
}): JSX.Element {
  const avatarDataUrl = chromeProfileAvatarDataUrl(profile);
  return avatarDataUrl ? (
    <img
      alt=""
      className="size-9 rounded-full"
      draggable={false}
      src={avatarDataUrl}
    />
  ) : (
    <span className="flex size-9 items-center justify-center rounded-full bg-[var(--transparency-block)] text-[var(--text-secondary)]">
      <ChromeIcon className="size-5" />
    </span>
  );
}
