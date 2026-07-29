export type AppCenterFactoryPresentationMode = "default" | "local-save";

export function resolveFactoryPublishActionKey(
  mode: AppCenterFactoryPresentationMode,
  update: boolean
): string {
  if (mode === "local-save") {
    return update ? "actions.saveAppUpdate" : "factory.actions.saveLocal";
  }
  return update ? "actions.publishAppUpdate" : "factory.actions.publish";
}

export function resolveFactoryStatusLabelKey(
  mode: AppCenterFactoryPresentationMode,
  status: string,
  fallbackKey: string
): string {
  return mode === "local-save" && status === "published"
    ? "factory.status.saved"
    : fallbackKey;
}
