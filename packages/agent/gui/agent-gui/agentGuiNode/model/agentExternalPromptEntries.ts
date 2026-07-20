import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";

export type AgentExternalPromptEntryResolution =
  | {
      disposition: "reference";
      reference: WorkspaceFileReference;
      sourceIndex: number;
    }
  | {
      disposition: "prepare";
      sourceIndex: number;
    };

export type AgentExternalPromptEntryResolver = (
  files: readonly File[]
) => readonly AgentExternalPromptEntryResolution[];

export type AgentResolvedExternalPromptEntry =
  | {
      disposition: "reference";
      reference: WorkspaceFileReference;
      sourceIndex: number;
    }
  | {
      disposition: "prepare";
      file: File;
      sourceIndex: number;
    };

export type AgentExternalPromptEntryInsertion =
  | {
      disposition: "reference";
      reference: WorkspaceFileReference;
    }
  | {
      disposition: "prepare";
      files: File[];
    };

export function resolveAgentExternalPromptEntries(
  files: readonly File[],
  resolver?: AgentExternalPromptEntryResolver | null
): AgentResolvedExternalPromptEntry[] {
  if (!resolver) return files.map(preparedEntry);

  let resolved: readonly AgentExternalPromptEntryResolution[];
  try {
    resolved = resolver(files);
  } catch {
    return files.map(preparedEntry);
  }

  const resultByIndex = new Map<number, AgentExternalPromptEntryResolution>();
  for (const result of resolved) {
    if (
      !Number.isInteger(result.sourceIndex) ||
      result.sourceIndex < 0 ||
      result.sourceIndex >= files.length ||
      resultByIndex.has(result.sourceIndex)
    ) {
      return files.map(preparedEntry);
    }
    if (result.disposition === "reference" && !result.reference.path.trim()) {
      return files.map(preparedEntry);
    }
    resultByIndex.set(result.sourceIndex, result);
  }
  if (resultByIndex.size !== files.length) return files.map(preparedEntry);

  return files.map((file, sourceIndex) => {
    const result = resultByIndex.get(sourceIndex)!;
    return result.disposition === "reference"
      ? {
          disposition: "reference" as const,
          reference: result.reference,
          sourceIndex
        }
      : preparedEntry(file, sourceIndex);
  });
}

export function groupAgentExternalPromptEntryInsertions(
  entries: readonly AgentResolvedExternalPromptEntry[]
): AgentExternalPromptEntryInsertion[] {
  const insertions: AgentExternalPromptEntryInsertion[] = [];
  for (const entry of entries) {
    if (entry.disposition === "reference") {
      insertions.push({
        disposition: "reference",
        reference: entry.reference
      });
      continue;
    }
    const previous = insertions.at(-1);
    if (previous?.disposition === "prepare") {
      previous.files.push(entry.file);
    } else {
      insertions.push({ disposition: "prepare", files: [entry.file] });
    }
  }
  return insertions;
}

function preparedEntry(file: File, sourceIndex: number) {
  return { disposition: "prepare" as const, file, sourceIndex };
}
