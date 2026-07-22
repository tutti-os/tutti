import { useCallback, useRef, useState } from "react";

interface ProjectMissingScopeIdentity {
  key: string;
  revision: number;
}

interface ScopedProjectMissingResult {
  identity: ProjectMissingScopeIdentity;
  isMissing: boolean;
}

export function useScopedProjectMissingState(
  scopeKey: string
): readonly [boolean, (isMissing: boolean) => void] {
  const identityRef = useRef<ProjectMissingScopeIdentity>({
    key: scopeKey,
    revision: 0
  });
  if (identityRef.current.key !== scopeKey) {
    identityRef.current = {
      key: scopeKey,
      revision: identityRef.current.revision + 1
    };
  }
  const identity = identityRef.current;
  const [result, setResult] = useState<ScopedProjectMissingResult>({
    identity,
    isMissing: false
  });

  const reportMissing = useCallback(
    (isMissing: boolean): void => {
      if (identityRef.current !== identity) {
        return;
      }
      setResult({ identity, isMissing });
    },
    [identity]
  );

  return [result.identity === identity && result.isMissing, reportMissing];
}
