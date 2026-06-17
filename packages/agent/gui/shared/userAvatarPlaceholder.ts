import userAvatarPlaceholderAssetUrl from "../app/renderer/assets/icons/user-avatar-placeholder.png";

/**
 * Bundled placeholder avatar shown for users without an avatar URL. Centralized
 * here so every surface (the agent composer mention palette, the message-center
 * card, and the desktop seam that enriches issue-manager session mentions)
 * resolves the SAME asset URL without duplicating the asset import.
 */
export const userAvatarPlaceholderUrl: string = userAvatarPlaceholderAssetUrl;
