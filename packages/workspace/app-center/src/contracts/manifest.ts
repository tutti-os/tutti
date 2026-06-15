export const workspaceAppManifestSchemaVersion = "tutti.app.manifest.v1";

export type WorkspaceAppManifestSchemaVersion =
  typeof workspaceAppManifestSchemaVersion;

export interface WorkspaceAppManifestIcon {
  readonly type: "asset";
  readonly src: string;
}

export interface WorkspaceAppManifestRuntime {
  readonly bootstrap: string;
  readonly healthcheckPath: string;
}

export interface WorkspaceAppManifestReferences {
  readonly listEndpoint: string;
}

export type WorkspaceAppManifestWindowMinimizeBehavior =
  | "hibernate"
  | "keep-mounted";

export interface WorkspaceAppManifestWindow {
  readonly minimizeBehavior?: WorkspaceAppManifestWindowMinimizeBehavior;
  readonly minHeight?: number;
  readonly minWidth?: number;
}

export interface WorkspaceAppManifestAuthor {
  readonly name: string;
  readonly url?: string;
}

export interface WorkspaceAppManifestLocalizationInfo {
  readonly defaultLocale: string;
  readonly additionalLocales?: readonly WorkspaceAppManifestLocalizationFile[];
}

export interface WorkspaceAppManifestLocalizationFile {
  readonly locale: string;
  readonly file: string;
}

export interface WorkspaceAppManifest {
  readonly schemaVersion: WorkspaceAppManifestSchemaVersion;
  readonly appId: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly icon?: WorkspaceAppManifestIcon;
  readonly runtime: WorkspaceAppManifestRuntime;
  readonly references?: WorkspaceAppManifestReferences;
  readonly window?: WorkspaceAppManifestWindow;
  readonly author?: WorkspaceAppManifestAuthor;
  readonly tags?: readonly string[];
  readonly localizationInfo?: WorkspaceAppManifestLocalizationInfo;
}
