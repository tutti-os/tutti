import type { WorkspaceAppManifest } from "./manifest.ts";

export type WorkspaceAppCatalogSourceKind =
  | "bundled"
  | "local"
  | "local-dev"
  | "remote";

export interface WorkspaceAppCatalogSource {
  readonly id?: string;
  readonly kind: WorkspaceAppCatalogSourceKind;
  readonly label?: string;
}

export interface WorkspaceAppCatalogLocalization {
  readonly locale: string;
  readonly name?: string | null;
  readonly description?: string | null;
  readonly tags?: readonly string[];
}

export interface WorkspaceAppCatalogEntry {
  readonly localizations?: readonly WorkspaceAppCatalogLocalization[];
  readonly manifest: WorkspaceAppManifest;
  readonly source?: WorkspaceAppCatalogSource;
}

export interface WorkspaceAppInstallRecord {
  readonly installationId?: string;
  readonly appId: string;
  readonly version?: string | null;
  readonly installedAt?: string | null;
  readonly updatedAt?: string | null;
  readonly catalogSourceId?: string | null;
}

export interface WorkspaceAppRecord {
  readonly availableIconUrl?: string | null;
  readonly availableVersion?: string | null;
  readonly catalog?: WorkspaceAppCatalogEntry | null;
  readonly category?: string | null;
  readonly createdAtUnixMs?: number | null;
  readonly install?: WorkspaceAppInstallRecord | null;
  readonly manifest: WorkspaceAppManifest;
  readonly updateAvailable?: boolean;
}
