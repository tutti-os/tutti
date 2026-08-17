import type {
  IssueManagerContextRef,
  IssueManagerFileReference
} from "../../../contracts/index.ts";
import {
  appendIssueManagerWorkspaceFileLinksToContent,
  type IssueManagerFeature
} from "../../../core/index.ts";
import type { IssueManagerReferenceTarget } from "../model.ts";
import {
  toContextRefInput,
  toIssueManagerWorkspaceFileLinkInput
} from "../controllerUtils.ts";

export function canIssueManagerRequestReferencesDirectly(
  fileAdapter: IssueManagerFeature["fileAdapter"]
): fileAdapter is NonNullable<IssueManagerFeature["fileAdapter"]> & {
  requestReferences: NonNullable<
    NonNullable<IssueManagerFeature["fileAdapter"]>["requestReferences"]
  >;
} {
  return Boolean(
    fileAdapter?.requestReferences &&
    !fileAdapter.loadReferenceTree &&
    !fileAdapter.listDirectory &&
    !fileAdapter.searchReferences
  );
}

export async function executeIssueManagerRequestReferences(input: {
  fileAdapter: NonNullable<IssueManagerFeature["fileAdapter"]> & {
    requestReferences: NonNullable<
      NonNullable<IssueManagerFeature["fileAdapter"]>["requestReferences"]
    >;
  };
  workspaceId: string;
}): Promise<IssueManagerFileReference[]> {
  return input.fileAdapter.requestReferences({
    workspaceId: input.workspaceId
  });
}

export function canIssueManagerUploadReferences(
  fileAdapter: IssueManagerFeature["fileAdapter"]
): fileAdapter is NonNullable<IssueManagerFeature["fileAdapter"]> & {
  requestUpload: NonNullable<
    NonNullable<IssueManagerFeature["fileAdapter"]>["requestUpload"]
  >;
} {
  return typeof fileAdapter?.requestUpload === "function";
}

export function canIssueManagerOpenReferences(
  fileAdapter: IssueManagerFeature["fileAdapter"]
): fileAdapter is NonNullable<IssueManagerFeature["fileAdapter"]> & {
  openReference: NonNullable<
    NonNullable<IssueManagerFeature["fileAdapter"]>["openReference"]
  >;
} {
  return typeof fileAdapter?.openReference === "function";
}

export function canIssueManagerOpenContextRefs(
  contextRefOpener: IssueManagerFeature["contextRefOpener"]
): contextRefOpener is NonNullable<IssueManagerFeature["contextRefOpener"]> {
  return typeof contextRefOpener?.openContextRef === "function";
}

export async function executeIssueManagerUploadReferences(input: {
  fileAdapter: NonNullable<IssueManagerFeature["fileAdapter"]> & {
    requestUpload: NonNullable<
      NonNullable<IssueManagerFeature["fileAdapter"]>["requestUpload"]
    >;
  };
  mode: "files" | "folder";
  workspaceId: string;
}): Promise<IssueManagerFileReference[]> {
  const refs = await input.fileAdapter.requestUpload({
    mode: input.mode,
    targetDirectoryPath: "/",
    workspaceId: input.workspaceId
  });

  if (refs.length === 0) {
    return refs;
  }

  await input.fileAdapter.refreshTree?.({
    depth: 1,
    paths: refs.map((ref) => ref.path),
    workspaceId: input.workspaceId
  });

  return refs;
}

export function resolveIssueManagerReferenceInsertionContent(input: {
  content: string;
  refs: IssueManagerFileReference[];
}): string {
  const preparedRefs = prepareIssueManagerReferences(input.refs);
  if (preparedRefs.length === 0) {
    return input.content;
  }

  return appendIssueManagerWorkspaceFileLinksToContent(
    input.content,
    preparedRefs.map(toIssueManagerWorkspaceFileLinkInput)
  );
}

export async function executeIssueManagerAttachReferences(input: {
  backend: IssueManagerFeature["backend"];
  refs: IssueManagerFileReference[];
  selectedIssueId: string | null;
  target: Exclude<IssueManagerReferenceTarget, { mode: "insert" }> | null;
  workspaceId: string;
}): Promise<boolean> {
  const preparedRefs = prepareIssueManagerReferences(input.refs);
  if (!input.target || preparedRefs.length === 0 || !input.selectedIssueId) {
    return false;
  }

  await input.backend.addContextRefs(
    input.target.parentKind === "task"
      ? {
          issueId: input.selectedIssueId,
          parentKind: "task",
          refs: preparedRefs.map(toContextRefInput),
          taskId: input.target.taskId,
          workspaceId: input.workspaceId
        }
      : {
          issueId: input.selectedIssueId,
          parentKind: "issue",
          refs: preparedRefs.map(toContextRefInput),
          workspaceId: input.workspaceId
        }
  );

  return true;
}

export async function executeIssueManagerOpenReference(input: {
  fileAdapter: NonNullable<IssueManagerFeature["fileAdapter"]> & {
    openReference: NonNullable<
      NonNullable<IssueManagerFeature["fileAdapter"]>["openReference"]
    >;
  };
  reference: IssueManagerFileReference;
}): Promise<void> {
  await input.fileAdapter.openReference(input.reference);
}

export async function executeIssueManagerOpenContextRef(input: {
  contextRefOpener: NonNullable<IssueManagerFeature["contextRefOpener"]>;
  reference: IssueManagerContextRef;
}): Promise<void> {
  await input.contextRefOpener.openContextRef(input.reference);
}

export async function executeIssueManagerRemoveContextRef(input: {
  backend: IssueManagerFeature["backend"];
  ref: IssueManagerContextRef;
  workspaceId: string;
}): Promise<void> {
  await input.backend.removeContextRef(
    input.ref.parentKind === "task"
      ? {
          contextRefId: input.ref.contextRefId,
          issueId: input.ref.issueId,
          parentKind: "task",
          taskId: input.ref.taskId,
          workspaceId: input.workspaceId
        }
      : {
          contextRefId: input.ref.contextRefId,
          issueId: input.ref.issueId,
          parentKind: "issue",
          workspaceId: input.workspaceId
        }
  );
}

function prepareIssueManagerReferences(
  refs: IssueManagerFileReference[]
): IssueManagerFileReference[] {
  return refs.filter((ref) => ref.path.trim().length > 0);
}
