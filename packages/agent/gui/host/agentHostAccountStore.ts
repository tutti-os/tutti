import { create } from "zustand";
import type {
  AgentHostAccountSnapshot,
  AgentHostAccountUserProfile,
  AgentHostEnsureAccountProfilesInput
} from "../shared/contracts/dto";
import { getOptionalAgentHostApi } from "../agentActivityHost";

const EMPTY_ACCOUNT_SNAPSHOT: AgentHostAccountSnapshot = {
  authStatus: "unauthenticated",
  currentUserId: null,
  currentUser: null,
  profilesByUserId: {}
};

const inFlightProfileLoads = new Map<
  string,
  Promise<AgentHostAccountSnapshot>
>();

export interface AccountStoreState extends AgentHostAccountSnapshot {
  applySnapshot: (snapshot: AgentHostAccountSnapshot) => void;
  ensureProfiles: (
    input: AgentHostEnsureAccountProfilesInput
  ) => Promise<AgentHostAccountSnapshot>;
  getProfile: (userId: string) => AgentHostAccountUserProfile | null;
  clear: () => void;
}

export const useAccountStore = create<AccountStoreState>((set, get) => ({
  ...cloneAccountSnapshot(EMPTY_ACCOUNT_SNAPSHOT),

  applySnapshot: (snapshot) => set(cloneAccountSnapshot(snapshot)),

  ensureProfiles: async (input) => {
    const normalizedUserIds = normalizeUserIds(input.userIds);
    if (normalizedUserIds.length === 0) {
      return cloneAccountSnapshot(get());
    }

    let missingUserIds = selectMissingUserIds(get(), normalizedUserIds);
    if (missingUserIds.length === 0) {
      return cloneAccountSnapshot(get());
    }

    const pendingLoads = collectInFlightProfileLoads(missingUserIds);
    if (pendingLoads.length > 0) {
      await Promise.allSettled(pendingLoads);
    }
    missingUserIds = selectMissingUserIds(get(), normalizedUserIds);
    if (missingUserIds.length === 0) {
      return cloneAccountSnapshot(get());
    }

    const accountApi = getOptionalAgentHostApi()?.account;
    if (!accountApi) {
      return cloneAccountSnapshot(get());
    }

    const requestPromise = (async () => {
      if (typeof accountApi.ensureProfiles !== "function") {
        const result = await accountApi.batchGetUserInfo({
          userIds: missingUserIds
        });
        const snapshot = mergeProfilesIntoSnapshot(get(), result.users);
        get().applySnapshot(snapshot);
        return cloneAccountSnapshot(snapshot);
      }

      const snapshot = await accountApi.ensureProfiles({
        userIds: missingUserIds
      });
      get().applySnapshot(snapshot);
      return cloneAccountSnapshot(snapshot);
    })();
    trackInFlightProfileLoad(missingUserIds, requestPromise);

    return await requestPromise;
  },

  getProfile: (userId) => {
    const normalizedUserId = userId.trim();
    return normalizedUserId
      ? (get().profilesByUserId[normalizedUserId] ?? null)
      : null;
  },

  clear: () => {
    inFlightProfileLoads.clear();
    set(cloneAccountSnapshot(EMPTY_ACCOUNT_SNAPSHOT));
  }
}));

function selectMissingUserIds(
  snapshot: AgentHostAccountSnapshot,
  userIds: string[]
): string[] {
  return userIds.filter((userId) => !snapshot.profilesByUserId[userId]);
}

function collectInFlightProfileLoads(
  userIds: string[]
): Promise<AgentHostAccountSnapshot>[] {
  return [
    ...new Set(
      userIds
        .map((userId) => inFlightProfileLoads.get(userId))
        .filter(
          (
            requestPromise
          ): requestPromise is Promise<AgentHostAccountSnapshot> =>
            requestPromise !== undefined
        )
    )
  ];
}

function trackInFlightProfileLoad(
  userIds: string[],
  requestPromise: Promise<AgentHostAccountSnapshot>
): void {
  for (const userId of userIds) {
    inFlightProfileLoads.set(userId, requestPromise);
  }

  requestPromise.finally(() => {
    for (const userId of userIds) {
      if (inFlightProfileLoads.get(userId) === requestPromise) {
        inFlightProfileLoads.delete(userId);
      }
    }
  });
}

export function normalizeUserIds(userIds: string[]): string[] {
  return [
    ...new Set(userIds.map((userId) => userId.trim()).filter(Boolean))
  ].sort();
}

function cloneAccountSnapshot(
  snapshot: AgentHostAccountSnapshot
): AgentHostAccountSnapshot {
  return {
    authStatus: snapshot.authStatus,
    currentUserId: snapshot.currentUserId,
    currentUser: snapshot.currentUser ? { ...snapshot.currentUser } : null,
    profilesByUserId: Object.fromEntries(
      Object.entries(snapshot.profilesByUserId).map(([userId, profile]) => [
        userId,
        { ...profile }
      ])
    )
  };
}

function mergeProfilesIntoSnapshot(
  snapshot: AgentHostAccountSnapshot,
  users: AgentHostAccountUserProfile[]
): AgentHostAccountSnapshot {
  const profilesByUserId = { ...snapshot.profilesByUserId };
  for (const user of users) {
    const userId = user.userId.trim();
    if (!userId) {
      continue;
    }
    profilesByUserId[userId] = {
      userId,
      ...(user.email?.trim() ? { email: user.email.trim() } : {}),
      ...(user.assetUrl?.trim() ? { assetUrl: user.assetUrl.trim() } : {}),
      ...(user.assetRef?.trim() ? { assetRef: user.assetRef.trim() } : {}),
      ...(user.name?.trim() ? { name: user.name.trim() } : {})
    };
  }
  const currentUserProfile = snapshot.currentUserId
    ? profilesByUserId[snapshot.currentUserId]
    : undefined;
  const currentUser: AgentHostAccountUserProfile | null =
    currentUserProfile ?? snapshot.currentUser ?? null;
  return {
    ...cloneAccountSnapshot(snapshot),
    currentUser,
    profilesByUserId
  };
}
