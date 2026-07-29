import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type JSX,
  type ReactNode
} from "react";
import {
  createRichTextMentionIdentityKey,
  createRichTextMentionService,
  type RichTextMentionService,
  type RichTextMentionSnapshot
} from "../service/index.ts";
import type { RichTextMentionIdentity } from "../types/mention.ts";
import type { RichTextTriggerProvider } from "../types/trigger.ts";

const RichTextMentionServiceContext =
  createContext<RichTextMentionService | null>(null);
const idleSnapshot: RichTextMentionSnapshot = Object.freeze({ state: "idle" });

export interface RichTextMentionServiceProviderProps {
  service: RichTextMentionService;
  children?: ReactNode;
}

export function RichTextMentionServiceProvider({
  service,
  children
}: RichTextMentionServiceProviderProps): JSX.Element {
  return (
    <RichTextMentionServiceContext.Provider value={service}>
      {children}
    </RichTextMentionServiceContext.Provider>
  );
}

export function useRichTextMentionService(
  explicitService?: RichTextMentionService
): RichTextMentionService | null {
  const contextService = useContext(RichTextMentionServiceContext);
  return explicitService ?? contextService;
}

export function useEffectiveRichTextMentionService(input: {
  mentionService?: RichTextMentionService;
  triggerProviders?: readonly RichTextTriggerProvider[];
}): RichTextMentionService {
  const contextService = useRichTextMentionService();
  const legacyService = useMemo(
    () =>
      input.mentionService || contextService
        ? null
        : createRichTextMentionService({
            providers: input.triggerProviders ?? []
          }),
    [contextService, input.mentionService, input.triggerProviders]
  );
  useEffect(() => () => legacyService?.dispose(), [legacyService]);
  return input.mentionService ?? contextService ?? legacyService!;
}

export function useResolvedRichTextMention(
  identity: RichTextMentionIdentity,
  explicitService?: RichTextMentionService
): RichTextMentionSnapshot {
  const service = useRichTextMentionService(explicitService);
  const identityKey = createRichTextMentionIdentityKey(identity);
  const stableIdentity = useMemo(
    () => identity,
    // Identity presentation fallback changes must still refresh the hook input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identityKey, identity.label]
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      service?.subscribe(listener, stableIdentity) ?? (() => {}),
    [service, stableIdentity]
  );
  const getSnapshot = useCallback(
    () => service?.getSnapshot(stableIdentity) ?? idleSnapshot,
    [service, stableIdentity]
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (service) void service.resolve(stableIdentity);
  }, [service, stableIdentity]);

  return snapshot;
}
