import metadata from "./components.json" with { type: "json" };

export type UISystemComponentCategory =
  | "primitive"
  | "composition"
  | "icon"
  | "style-entry"
  | "utility";

export type UISystemComponentStatus = "experimental" | "stable" | "deprecated";

export type UISystemComponentLayer = "base" | "business";

export type UISystemIconVariant = "lined" | "filled";

export interface UISystemComponentMetadata {
  id: string;
  layer: UISystemComponentLayer;
  name: string;
  export: string;
  from: string;
  category: UISystemComponentCategory;
  status: UISystemComponentStatus;
  source: string;
  iconVariant?: UISystemIconVariant;
  propsType?: string;
  description: string;
  useCases: string[];
  migrationHints: string[];
  nativePreview?: boolean;
  storyboard?: boolean;
}

export interface UISystemMetadata {
  schemaVersion: number;
  components: UISystemComponentMetadata[];
}

export const uiSystemMetadata = metadata as UISystemMetadata;
