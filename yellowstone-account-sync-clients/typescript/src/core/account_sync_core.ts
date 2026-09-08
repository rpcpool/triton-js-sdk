import {
  AccountBuffer,
  type AccountBufferObservation,
  type AccountBufferReadResult
} from "./account_buffer";
import {
  AccountSyncAccountLimitError,
  AccountSyncReadTimeoutError
} from "./errors";
import type {
  AccountSyncInitialStatePlugin,
  InitialStateHydrationContext
} from "./initial_state_plugin";
import { SubscriptionRegistry } from "./subscription_registry";
import type {
  AccountSubscriptionTransport,
  AccountSubscriptionTransportFactory
} from "./transport";
import type {
  AccountReadConstraints,
  AccountSyncCommitment,
  BufferedAccountState,
  DecodedAccountUpdate
} from "./types";

const DEFAULT_RPC_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 100;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_DYNAMIC_SUBSCRIPTION_TTL_MS = 60_000;
const DEFAULT_MAX_ACCOUNTS_PER_COMMITMENT = 10_000;

export interface AccountSyncCoreSettings {
  transportFactory: AccountSubscriptionTransportFactory;
  initialStatePlugin: AccountSyncInitialStatePlugin;
  commitment: AccountSyncCommitment;
  initialAccountIds: readonly string[];
  autoSubscribeOnMiss: boolean;
  missTimeoutMs: number;
  rpcPollIntervalMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  closeTimeoutMs?: number;
  dynamicSubscriptionTtlMs?: number;
  maxAccountsPerCommitment?: number;
  onAccountsInvalidated?: (
    accountIds: readonly string[],
    commitment: AccountSyncCommitment
  ) => void;
}

type LaneStatus = "starting" | "streaming" | "polling" | "recovering" | "closed";
type AccountOwnershipToken = object;

interface CommitmentLane {
  commitment: AccountSyncCommitment;
  transport: AccountSubscriptionTransport | null;
  transportGeneration: number;
  sessionAlive: boolean;
  status: LaneStatus;
  accountBuffer: AccountBuffer;
  subscriptionRegistry: SubscriptionRegistry;
  registryVersion: number;
  hydratedRegistryVersion: number | null;
  initialHydrationTask: Promise<void> | null;
  hydrationRetryTimer: ReturnType<typeof setTimeout> | null;
  hydrationRetryDelayMs: number;
  readyPromise: Promise<void>;
  reconnectTask: Promise<void> | null;
  rpcRefreshTask: Promise<number> | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  pollAgain: boolean;
  pollContinuationScheduled: boolean;
  operationChain: Promise<void>;
  pinnedAccountIds: Set<string>;
  leasedAccountExpiresAtMs: Map<string, number>;
  activeReadsByAccountId: Map<string, number>;
  ownershipTokenByAccountId: Map<string, AccountOwnershipToken>;
  hydrationGateByAccountId: Map<string, AccountOwnershipToken>;
  stagedUpdateByAccountId: Map<
    string,
    { ownershipToken: AccountOwnershipToken; update: DecodedAccountUpdate }
  >;
  leaseTimer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController;
}

export type AccountSyncAccountObservation = AccountBufferObservation;

// What: Transport-agnostic orchestration for local account buffering.
// Why: Keep buffering, RPC fallback, and reconnection independent from grpc/ws.
// How: Own one recovery state machine, transport, registry, and buffer per commitment.
export class AccountSyncCore {
  private readonly transportFactory: AccountSubscriptionTransportFactory;
  private readonly initialStatePlugin: AccountSyncInitialStatePlugin;
  private readonly defaultCommitment: AccountSyncCommitment;
  private readonly lanesByCommitment = new Map<AccountSyncCommitment, CommitmentLane>();
  private readonly autoSubscribeOnMiss: boolean;
  private readonly missTimeoutMs: number;
  private readonly rpcPollIntervalMs: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly closeTimeoutMs: number;
  private readonly dynamicSubscriptionTtlMs: number;
  private readonly maxAccountsPerCommitment: number;
  private readonly onAccountsInvalidated?: AccountSyncCoreSettings["onAccountsInvalidated"];
  private readonly lifecycleAbortController = new AbortController();

  private readonly readyPromise: Promise<void>;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private lastTransportError: Error | null = null;

  constructor(settings: AccountSyncCoreSettings) {
    this.transportFactory = settings.transportFactory;
    this.initialStatePlugin = settings.initialStatePlugin;
    this.defaultCommitment = settings.commitment;
    this.autoSubscribeOnMiss = settings.autoSubscribeOnMiss;
    this.missTimeoutMs = settings.missTimeoutMs;
    this.rpcPollIntervalMs =
      settings.rpcPollIntervalMs ?? DEFAULT_RPC_POLL_INTERVAL_MS;
    this.reconnectInitialDelayMs =
      settings.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
    this.reconnectMaxDelayMs =
      settings.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.closeTimeoutMs = settings.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.dynamicSubscriptionTtlMs =
      settings.dynamicSubscriptionTtlMs ?? DEFAULT_DYNAMIC_SUBSCRIPTION_TTL_MS;
    this.maxAccountsPerCommitment =
      settings.maxAccountsPerCommitment ?? DEFAULT_MAX_ACCOUNTS_PER_COMMITMENT;
    this.onAccountsInvalidated = settings.onAccountsInvalidated;
    assertPositiveSafeInteger(
      this.dynamicSubscriptionTtlMs,
      "dynamicSubscriptionTtlMs"
    );
    assertPositiveSafeInteger(
      this.maxAccountsPerCommitment,
      "maxAccountsPerCommitment"
    );
    if (
      new Set(settings.initialAccountIds).size > this.maxAccountsPerCommitment
    ) {
      throw createAccountLimitError(
        settings.commitment,
        this.maxAccountsPerCommitment
      );
    }

    const defaultLane = this.createCommitmentLane(
      settings.commitment,
      settings.initialAccountIds
    );
    this.readyPromise = defaultLane.readyPromise;
  }

  public async ready(): Promise<void> {
    await this.readyPromise;
  }

  public getLastTransportError(): Error | null {
    return this.lastTransportError;
  }

  public async addTrackedAccounts(
    accountIds: readonly string[],
    commitment: AccountSyncCommitment = this.defaultCommitment
  ): Promise<void> {
    const lane = this.getOrCreateCommitmentLane(commitment, []);
    await this.enqueueLaneOperation(lane, async () => {
      const nextPinned = new Set([...lane.pinnedAccountIds, ...accountIds]);
      if (nextPinned.size > this.maxAccountsPerCommitment) {
        throw createAccountLimitError(commitment, this.maxAccountsPerCommitment);
      }
      const protectedAccountIds = new Set(
        [...lane.leasedAccountExpiresAtMs.keys()].filter((accountId) =>
          hasActiveRead(lane, accountId)
        )
      );
      for (const accountId of nextPinned) {
        protectedAccountIds.delete(accountId);
      }
      if (
        nextPinned.size + protectedAccountIds.size >
        this.maxAccountsPerCommitment
      ) {
        throw createAccountLimitError(commitment, this.maxAccountsPerCommitment);
      }
      for (const accountId of accountIds) {
        if (!this.hasAccountOwnership(lane, accountId)) {
          this.startAccountOwnership(lane, accountId);
        }
        lane.leasedAccountExpiresAtMs.delete(accountId);
      }
      lane.pinnedAccountIds = nextPinned;
      this.evictLeasesToFit(lane);
      if (!this.syncRegistryFromOwnership(lane)) {
        this.scheduleLeaseExpiry(lane);
        return;
      }
      lane.registryVersion += 1;
      await this.applyLaneSubscription(lane);
      this.scheduleLeaseExpiry(lane);
    });
  }

  public async removeTrackedAccounts(
    accountIds: readonly string[],
    commitment: AccountSyncCommitment = this.defaultCommitment
  ): Promise<void> {
    const lane = this.lanesByCommitment.get(commitment);
    if (!lane) {
      if (accountIds.length > 0) {
        this.onAccountsInvalidated?.([...new Set(accountIds)], commitment);
      }
      return;
    }
    await this.enqueueLaneOperation(lane, async () => {
      for (const accountId of accountIds) {
        this.invalidateAccountOwnership(lane, accountId);
      }
      this.notifyAccountsInvalidated(lane, accountIds);
      if (!this.syncRegistryFromOwnership(lane)) {
        this.scheduleLeaseExpiry(lane);
        this.releaseLaneIfUnused(lane);
        return;
      }
      lane.registryVersion += 1;
      await this.applyLaneSubscription(lane);
      this.scheduleLeaseExpiry(lane);
      this.releaseLaneIfUnused(lane);
    });
  }

  public async setTrackedAccounts(
    accountIds: readonly string[],
    commitment: AccountSyncCommitment = this.defaultCommitment
  ): Promise<void> {
    if (new Set(accountIds).size > this.maxAccountsPerCommitment) {
      throw createAccountLimitError(commitment, this.maxAccountsPerCommitment);
    }
    const lane = this.getOrCreateCommitmentLane(commitment, []);
    await this.enqueueLaneOperation(lane, async () => {
      const nextPinned = new Set(accountIds);
      const invalidatedAccountIds: string[] = [];
      for (const accountId of lane.subscriptionRegistry.snapshot()) {
        if (
          !nextPinned.has(accountId) &&
          this.invalidateAccountOwnership(lane, accountId)
        ) {
          invalidatedAccountIds.push(accountId);
        }
      }
      for (const accountId of nextPinned) {
        if (!this.hasAccountOwnership(lane, accountId)) {
          this.startAccountOwnership(lane, accountId);
        }
      }
      for (const accountId of [...lane.leasedAccountExpiresAtMs.keys()]) {
        if (!nextPinned.has(accountId)) {
          if (this.invalidateAccountOwnership(lane, accountId)) {
            invalidatedAccountIds.push(accountId);
          }
        }
      }
      lane.pinnedAccountIds = nextPinned;
      lane.leasedAccountExpiresAtMs.clear();
      this.notifyAccountsInvalidated(lane, invalidatedAccountIds);
      if (!this.syncRegistryFromOwnership(lane)) {
        this.scheduleLeaseExpiry(lane);
        this.releaseLaneIfUnused(lane);
        return;
      }
      lane.registryVersion += 1;
      await this.applyLaneSubscription(lane);
      this.scheduleLeaseExpiry(lane);
      this.releaseLaneIfUnused(lane);
    });
  }

  public async getBufferedAccount(
    accountId: string,
    commitment: AccountSyncCommitment = this.defaultCommitment,
    constraints?: AccountReadConstraints
  ): Promise<BufferedAccountState | null> {
    const observation = await this.getBufferedAccountObservation(
      accountId,
      commitment,
      constraints
    );
    return observationToPublicValue(observation);
  }

  public async getBufferedAccountObservation(
    accountId: string,
    commitment: AccountSyncCommitment = this.defaultCommitment,
    constraints?: AccountReadConstraints
  ): Promise<AccountSyncAccountObservation> {
    const results = await this.getBufferedAccountObservationsInternal(
      [accountId],
      commitment,
      constraints,
      `failed to get info about account ${accountId}`
    );
    return results[0];
  }

  public async getBufferedAccounts(
    accountIds: readonly string[],
    commitment: AccountSyncCommitment = this.defaultCommitment,
    constraints?: AccountReadConstraints
  ): Promise<(BufferedAccountState | null)[]> {
    const observations = await this.getBufferedAccountObservations(
      accountIds,
      commitment,
      constraints
    );
    return observations.map(observationToPublicValue);
  }

  public async getBufferedAccountObservations(
    accountIds: readonly string[],
    commitment: AccountSyncCommitment = this.defaultCommitment,
    constraints?: AccountReadConstraints
  ): Promise<AccountSyncAccountObservation[]> {
    return this.getBufferedAccountObservationsInternal(
      accountIds,
      commitment,
      constraints,
      `failed to get info for accounts ${accountIds}`
    );
  }

  private async getBufferedAccountObservationsInternal(
    accountIds: readonly string[],
    commitment: AccountSyncCommitment,
    constraints: AccountReadConstraints | undefined,
    rpcErrorMessage: string
  ): Promise<AccountSyncAccountObservation[]> {
    this.assertOpen();
    if (accountIds.length === 0) {
      return [];
    }
    const minContextSlot = constraints?.minContextSlot;
    const shouldSubscribe =
      this.autoSubscribeOnMiss || commitment !== this.defaultCommitment;
    const lane = this.getOrCreateCommitmentLane(commitment, []);
    let readOwnershipTokens = new Map<
      string,
      AccountOwnershipToken | undefined
    >();
    const lookup = await this.enqueueLaneOperation(lane, async () => {
      await lane.readyPromise;
      this.assertOpen();

      const subscriptionChanged = this.beginAccountReads(
        lane,
        accountIds,
        shouldSubscribe
      );
      if (subscriptionChanged) {
        lane.registryVersion += 1;
        try {
          await this.applyLaneSubscription(lane);
        } catch (error: unknown) {
          this.finishAccountReads(lane, accountIds);
          throw error;
        }
      } else if (lane.status !== "streaming") {
        this.requestImmediatePoll(lane);
      }

      readOwnershipTokens = new Map(
        accountIds.map((accountId) => [
          accountId,
          lane.ownershipTokenByAccountId.get(accountId)
        ])
      );

      return lane;
    });

    const observations = accountIds.map((accountId) => {
      if (
        !lookup.subscriptionRegistry.has(accountId) ||
        lookup.hydrationGateByAccountId.has(accountId) ||
        lookup.ownershipTokenByAccountId.get(accountId) !==
          readOwnershipTokens.get(accountId)
      ) {
        return null;
      }
      return lookup.accountBuffer.observe(accountId, minContextSlot);
    });
    const resultCameFromBuffer = observations.map(
      (observation) => observation !== null
    );
    const unresolvedIndexes = observations.flatMap((observation, index) =>
      observation ? [] : [index]
    );
    const unresolvedAccountIds = unresolvedIndexes.map(
      (index) => accountIds[index]
    );

    const readAbortController = new AbortController();
    const abortRead = () => readAbortController.abort();
    if (this.lifecycleAbortController.signal.aborted) {
      readAbortController.abort();
    } else {
      this.lifecycleAbortController.signal.addEventListener("abort", abortRead, {
        once: true
      });
    }
    try {
      if (unresolvedAccountIds.length > 0) {
        const bufferedRead = Promise.all(
          unresolvedAccountIds.map((accountId) =>
            lookup.accountBuffer.waitForAccount(
              accountId,
              this.missTimeoutMs,
              minContextSlot,
              readAbortController.signal
            )
          )
        );
        const rpcRead = this.readAccountsFromRpc(
          lookup,
          unresolvedAccountIds,
          minContextSlot,
          rpcErrorMessage,
          readAbortController.signal,
          readOwnershipTokens
        );
        const firstResult = await Promise.race([
          bufferedRead.then((results) => ({ source: "buffer" as const, results })),
          rpcRead.then((results) => ({ source: "rpc" as const, results }))
        ]);
        const bufferedResultWasInvalidated =
          firstResult.source === "buffer" &&
          unresolvedAccountIds.some(
            (accountId) =>
              lookup.ownershipTokenByAccountId.get(accountId) !==
              readOwnershipTokens.get(accountId)
          );
        const results = bufferedResultWasInvalidated
          ? await rpcRead
          : firstResult.results;
        const timedOutIndex = results.findIndex(
          (result) => result.kind === "timeout"
        );
        if (timedOutIndex !== -1) {
          throw new AccountSyncReadTimeoutError({
            accountId: unresolvedAccountIds[timedOutIndex],
            commitment,
            timeoutMs: this.missTimeoutMs,
            minContextSlot
          });
        }
        for (const [resultIndex, accountIndex] of unresolvedIndexes.entries()) {
          observations[accountIndex] =
            results[resultIndex] as AccountBufferObservation;
          resultCameFromBuffer[accountIndex] =
            firstResult.source === "buffer" && !bufferedResultWasInvalidated;
        }
      }

      const invalidatedBufferedIndexes = accountIds.flatMap(
        (accountId, index) =>
          resultCameFromBuffer[index] &&
          lookup.ownershipTokenByAccountId.get(accountId) !==
            readOwnershipTokens.get(accountId)
            ? [index]
            : []
      );
      if (invalidatedBufferedIndexes.length > 0) {
        const invalidatedAccountIds = invalidatedBufferedIndexes.map(
          (index) => accountIds[index]
        );
        const rpcResults = await this.readAccountsFromRpc(
          lookup,
          invalidatedAccountIds,
          minContextSlot,
          rpcErrorMessage,
          readAbortController.signal,
          readOwnershipTokens
        );
        for (const [resultIndex, accountIndex] of invalidatedBufferedIndexes.entries()) {
          observations[accountIndex] =
            rpcResults[resultIndex] as AccountBufferObservation;
        }
      }
      return observations as AccountSyncAccountObservation[];
    } finally {
      this.lifecycleAbortController.signal.removeEventListener("abort", abortRead);
      readAbortController.abort();
      this.finishAccountReads(lookup, accountIds);
    }
  }

  private beginAccountReads(
    lane: CommitmentLane,
    accountIds: readonly string[],
    shouldSubscribe: boolean
  ): boolean {
    const now = Date.now();
    for (const accountId of new Set(accountIds)) {
      lane.activeReadsByAccountId.set(
        accountId,
        (lane.activeReadsByAccountId.get(accountId) ?? 0) + 1
      );
      if (!shouldSubscribe || lane.pinnedAccountIds.has(accountId)) {
        continue;
      }
      if (!lane.leasedAccountExpiresAtMs.has(accountId)) {
        while (
          lane.pinnedAccountIds.size +
            lane.leasedAccountExpiresAtMs.size >=
          this.maxAccountsPerCommitment
        ) {
          const evicted = this.evictOldestLease(lane, new Set([accountId]));
          if (!evicted) {
            break;
          }
        }
      }
      if (
        lane.leasedAccountExpiresAtMs.has(accountId) ||
        lane.pinnedAccountIds.size +
            lane.leasedAccountExpiresAtMs.size <
          this.maxAccountsPerCommitment
      ) {
        if (!this.hasAccountOwnership(lane, accountId)) {
          this.startAccountOwnership(lane, accountId);
        }
        lane.leasedAccountExpiresAtMs.set(
          accountId,
          now + this.dynamicSubscriptionTtlMs
        );
      }
    }
    const changed = this.syncRegistryFromOwnership(lane);
    this.scheduleLeaseExpiry(lane);
    return changed;
  }

  private finishAccountReads(
    lane: CommitmentLane,
    accountIds: readonly string[]
  ): void {
    const now = Date.now();
    for (const accountId of new Set(accountIds)) {
      const activeReads = lane.activeReadsByAccountId.get(accountId) ?? 0;
      if (activeReads <= 1) {
        lane.activeReadsByAccountId.delete(accountId);
      } else {
        lane.activeReadsByAccountId.set(accountId, activeReads - 1);
      }
      if (lane.leasedAccountExpiresAtMs.has(accountId)) {
        lane.leasedAccountExpiresAtMs.set(
          accountId,
          now + this.dynamicSubscriptionTtlMs
        );
      } else if (!lane.pinnedAccountIds.has(accountId) && activeReads <= 1) {
        lane.accountBuffer.delete(accountId);
      }
    }
    this.queueOwnershipSync(lane);
  }

  private evictLeasesToFit(lane: CommitmentLane): void {
    while (
      lane.pinnedAccountIds.size + lane.leasedAccountExpiresAtMs.size >
      this.maxAccountsPerCommitment
    ) {
      if (!this.evictOldestLease(lane, lane.pinnedAccountIds)) {
        break;
      }
    }
  }

  private evictOldestLease(
    lane: CommitmentLane,
    excludedAccountIds: ReadonlySet<string>
  ): string | null {
    let oldestAccountId: string | null = null;
    let oldestExpiry = Number.POSITIVE_INFINITY;
    for (const [accountId, expiresAtMs] of lane.leasedAccountExpiresAtMs) {
      if (
        excludedAccountIds.has(accountId) ||
        hasActiveRead(lane, accountId)
      ) {
        continue;
      }
      if (expiresAtMs < oldestExpiry) {
        oldestAccountId = accountId;
        oldestExpiry = expiresAtMs;
      }
    }
    if (!oldestAccountId) {
      return null;
    }
    this.invalidateAccountOwnership(lane, oldestAccountId);
    this.notifyAccountsInvalidated(lane, [oldestAccountId]);
    return oldestAccountId;
  }

  private syncRegistryFromOwnership(lane: CommitmentLane): boolean {
    return lane.subscriptionRegistry.set([
      ...lane.pinnedAccountIds,
      ...lane.leasedAccountExpiresAtMs.keys()
    ]);
  }

  private hasAccountOwnership(
    lane: CommitmentLane,
    accountId: string
  ): boolean {
    return (
      lane.pinnedAccountIds.has(accountId) ||
      lane.leasedAccountExpiresAtMs.has(accountId)
    );
  }

  private startAccountOwnership(
    lane: CommitmentLane,
    accountId: string
  ): AccountOwnershipToken {
    const ownershipToken: AccountOwnershipToken = {};
    lane.ownershipTokenByAccountId.set(accountId, ownershipToken);
    lane.hydrationGateByAccountId.set(accountId, ownershipToken);
    lane.stagedUpdateByAccountId.delete(accountId);
    lane.accountBuffer.delete(accountId);
    return ownershipToken;
  }

  private invalidateAccountOwnership(
    lane: CommitmentLane,
    accountId: string
  ): boolean {
    const wasOwned = this.hasAccountOwnership(lane, accountId);
    lane.pinnedAccountIds.delete(accountId);
    lane.leasedAccountExpiresAtMs.delete(accountId);
    lane.ownershipTokenByAccountId.delete(accountId);
    lane.hydrationGateByAccountId.delete(accountId);
    lane.stagedUpdateByAccountId.delete(accountId);
    const deleted = lane.accountBuffer.delete(accountId);
    return wasOwned || deleted;
  }

  private notifyAccountsInvalidated(
    lane: CommitmentLane,
    accountIds: readonly string[]
  ): void {
    if (accountIds.length > 0) {
      this.onAccountsInvalidated?.([...new Set(accountIds)], lane.commitment);
    }
  }

  private queueOwnershipSync(lane: CommitmentLane): void {
    if (this.closed || lane.status === "closed") {
      return;
    }
    void this.enqueueLaneOperation(lane, async () => {
      if (this.syncRegistryFromOwnership(lane)) {
        lane.registryVersion += 1;
        await this.applyLaneSubscription(lane);
      }
      this.scheduleLeaseExpiry(lane);
      this.releaseLaneIfUnused(lane);
    }).catch((error: unknown) => {
      if (!this.closed && !isAbortError(error)) {
        this.lastTransportError = toError(error);
      }
    });
  }

  private scheduleLeaseExpiry(lane: CommitmentLane): void {
    if (lane.leaseTimer) {
      clearTimeout(lane.leaseTimer);
      lane.leaseTimer = null;
    }
    if (this.closed || lane.status === "closed") {
      return;
    }
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [accountId, expiresAtMs] of lane.leasedAccountExpiresAtMs) {
      if (!hasActiveRead(lane, accountId)) {
        nextExpiry = Math.min(nextExpiry, expiresAtMs);
      }
    }
    if (!Number.isFinite(nextExpiry)) {
      return;
    }
    lane.leaseTimer = setTimeout(() => {
      lane.leaseTimer = null;
      void this.expireLeases(lane);
    }, Math.max(0, nextExpiry - Date.now()));
  }

  private async expireLeases(lane: CommitmentLane): Promise<void> {
    if (this.closed || lane.status === "closed") {
      return;
    }
    await this.enqueueLaneOperation(lane, async () => {
      const now = Date.now();
      for (const [accountId, expiresAtMs] of lane.leasedAccountExpiresAtMs) {
        if (expiresAtMs > now || hasActiveRead(lane, accountId)) {
          continue;
        }
        this.invalidateAccountOwnership(lane, accountId);
        this.notifyAccountsInvalidated(lane, [accountId]);
      }
      if (this.syncRegistryFromOwnership(lane)) {
        lane.registryVersion += 1;
        await this.applyLaneSubscription(lane);
      }
      this.scheduleLeaseExpiry(lane);
      this.releaseLaneIfUnused(lane);
    }).catch((error: unknown) => {
      if (!this.closed && !isAbortError(error)) {
        this.lastTransportError = toError(error);
      }
    });
  }

  private releaseLaneIfUnused(lane: CommitmentLane): void {
    if (
      lane.commitment === this.defaultCommitment ||
      lane.subscriptionRegistry.snapshot().length > 0 ||
      lane.activeReadsByAccountId.size > 0 ||
      this.lanesByCommitment.get(lane.commitment) !== lane
    ) {
      return;
    }
    lane.status = "closed";
    lane.sessionAlive = false;
    lane.transportGeneration += 1;
    lane.abortController.abort();
    this.cancelHydrationRetry(lane);
    this.stopPolling(lane);
    if (lane.leaseTimer) {
      clearTimeout(lane.leaseTimer);
      lane.leaseTimer = null;
    }
    this.lanesByCommitment.delete(lane.commitment);
    const transport = lane.transport;
    lane.transport = null;
    void transport?.close().catch((error: unknown) => {
      this.lastTransportError = toError(error);
    });
  }

  public close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeOnce();
    }
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.lifecycleAbortController.abort();
    const lanes = [...this.lanesByCommitment.values()];
    for (const lane of this.lanesByCommitment.values()) {
      lane.status = "closed";
      lane.sessionAlive = false;
      lane.transportGeneration += 1;
      lane.abortController.abort();
      if (lane.pollTimer) {
        clearTimeout(lane.pollTimer);
        lane.pollTimer = null;
      }
      this.cancelHydrationRetry(lane);
      if (lane.leaseTimer) {
        clearTimeout(lane.leaseTimer);
        lane.leaseTimer = null;
      }
    }

    const transportCloseTasks = lanes.map(async (lane) => {
      const transport = lane.transport;
      lane.transport = null;
      await transport?.close();
    });
    const backgroundTasks = lanes.flatMap((lane) =>
      [lane.reconnectTask, lane.rpcRefreshTask, lane.initialHydrationTask].filter(
        (task): task is Promise<void> | Promise<number> => task !== null
      )
    );

    const shutdown = Promise.all([
      Promise.all(transportCloseTasks),
      Promise.allSettled(backgroundTasks)
    ]).then(() => undefined);
    await withTimeout(
      shutdown,
      this.closeTimeoutMs,
      createCloseTimeoutError(this.closeTimeoutMs)
    );
  }

  private getDefaultLane(): CommitmentLane {
    return this.getOrCreateCommitmentLane(this.defaultCommitment, []);
  }

  private getOrCreateCommitmentLane(
    commitment: AccountSyncCommitment,
    initialAccountIds: readonly string[]
  ): CommitmentLane {
    return (
      this.lanesByCommitment.get(commitment) ??
      this.createCommitmentLane(commitment, initialAccountIds)
    );
  }

  private createCommitmentLane(
    commitment: AccountSyncCommitment,
    initialAccountIds: readonly string[]
  ): CommitmentLane {
    const lane: CommitmentLane = {
      commitment,
      transport: null,
      transportGeneration: 0,
      sessionAlive: false,
      status: "starting",
      accountBuffer: new AccountBuffer(),
      subscriptionRegistry: new SubscriptionRegistry(initialAccountIds),
      registryVersion: 0,
      hydratedRegistryVersion: null,
      initialHydrationTask: null,
      hydrationRetryTimer: null,
      hydrationRetryDelayMs: this.rpcPollIntervalMs,
      readyPromise: Promise.resolve(),
      reconnectTask: null,
      rpcRefreshTask: null,
      pollTimer: null,
      pollAgain: false,
      pollContinuationScheduled: false,
      operationChain: Promise.resolve(),
      pinnedAccountIds: new Set(initialAccountIds),
      leasedAccountExpiresAtMs: new Map(),
      activeReadsByAccountId: new Map(),
      ownershipTokenByAccountId: new Map(
        initialAccountIds.map((accountId) => [accountId, {}])
      ),
      hydrationGateByAccountId: new Map(),
      stagedUpdateByAccountId: new Map(),
      leaseTimer: null,
      abortController: new AbortController()
    };
    this.lanesByCommitment.set(commitment, lane);
    lane.readyPromise = this.initializeLane(lane);
    return lane;
  }

  private async initializeLane(lane: CommitmentLane): Promise<void> {
    try {
      await this.openStreamAndSubscribe(lane);
      lane.status = "streaming";
      this.requestInitialStateHydration(lane);
    } catch (error: unknown) {
      if (this.closed || isAbortError(error)) {
        lane.status = "closed";
        lane.sessionAlive = false;
        return;
      }
      this.lastTransportError = toError(error);
      lane.status = "polling";
      this.startPolling(lane);
      this.startReconnectLoop(lane);
    }
  }

  private async applyLaneSubscription(lane: CommitmentLane): Promise<void> {
    await lane.readyPromise;
    this.assertOpen();
    const accountIds = lane.subscriptionRegistry.snapshot();

    if (lane.status !== "streaming" || !lane.transport || !lane.sessionAlive) {
      this.requestImmediatePoll(lane);
      return;
    }

    this.requestInitialStateHydration(lane);

    const generation = lane.transportGeneration;
    try {
      await lane.transport.setTrackedAccounts(accountIds, lane.commitment);
    } catch (error: unknown) {
      this.handleTransportDisconnect(lane, generation, toError(error));
    }
  }

  private async openStreamAndSubscribe(lane: CommitmentLane): Promise<void> {
    const previousTransport = lane.transport;
    const transport = this.transportFactory(lane.commitment);
    const generation = lane.transportGeneration + 1;
    lane.transportGeneration = generation;
    lane.transport = transport;
    lane.sessionAlive = true;

    if (previousTransport) {
      void previousTransport.close().catch(() => undefined);
    }

    try {
      await transport.connect(
        {
          onAccountUpdate: (update) => {
            if (
              !this.closed &&
              lane.transportGeneration === generation &&
              lane.sessionAlive &&
              lane.subscriptionRegistry.has(update.accountId)
            ) {
              const ownershipToken =
                lane.ownershipTokenByAccountId.get(update.accountId);
              if (!ownershipToken) {
                return;
              }
              if (
                lane.hydrationGateByAccountId.get(update.accountId) ===
                ownershipToken
              ) {
                const staged = lane.stagedUpdateByAccountId.get(update.accountId);
                if (
                  !staged ||
                  staged.ownershipToken !== ownershipToken ||
                  isNewerDecodedUpdate(update, staged.update)
                ) {
                  lane.stagedUpdateByAccountId.set(update.accountId, {
                    ownershipToken,
                    update
                  });
                }
              } else {
                lane.accountBuffer.upsert(update);
              }
            }
          },
          onTransportError: (error) => {
            this.handleTransportDisconnect(lane, generation, error);
          }
        },
        lane.abortController.signal
      );
      this.assertCurrentSession(lane, generation);
      await transport.setTrackedAccounts(
        lane.subscriptionRegistry.snapshot(),
        lane.commitment
      );
      this.assertCurrentSession(lane, generation);
    } catch (error: unknown) {
      if (lane.transportGeneration === generation) {
        lane.sessionAlive = false;
      }
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  private handleTransportDisconnect(
    lane: CommitmentLane,
    generation: number,
    error: Error
  ): void {
    if (
      this.closed ||
      lane.status === "closed" ||
      lane.transportGeneration !== generation ||
      !lane.sessionAlive
    ) {
      return;
    }

    this.lastTransportError = error;
    lane.sessionAlive = false;
    lane.status = "polling";
    this.cancelHydrationRetry(lane);
    this.startPolling(lane);
    this.startReconnectLoop(lane);
  }

  private startReconnectLoop(lane: CommitmentLane): void {
    if (lane.reconnectTask || this.closed || lane.status === "closed") {
      return;
    }

    lane.reconnectTask = this.runReconnectLoop(lane).finally(() => {
      lane.reconnectTask = null;
      if (!this.closed && lane.status === "polling") {
        this.startReconnectLoop(lane);
      }
    });
  }

  private async runReconnectLoop(lane: CommitmentLane): Promise<void> {
    let delayMs = this.reconnectInitialDelayMs;
    while (!this.closed && lane.status !== "closed") {
      try {
        await abortableDelay(delayMs, lane.abortController.signal);
      } catch (error: unknown) {
        if (isAbortError(error)) {
          return;
        }
        throw error;
      }
      if (this.closed) {
        return;
      }

      lane.status = "recovering";
      try {
        await this.openStreamAndSubscribe(lane);
        await this.reconcileLaneFromRpc(lane);
        if (!lane.sessionAlive) {
          throw new Error("account-sync stream disconnected during reconciliation");
        }

        lane.status = "streaming";
        this.stopPolling(lane);
        this.requestInitialStateHydration(lane);
        return;
      } catch (error: unknown) {
        if (this.closed || isAbortError(error)) {
          return;
        }
        this.lastTransportError = toError(error);
        lane.status = "polling";
        this.startPolling(lane);
        delayMs = Math.min(delayMs * 2, this.reconnectMaxDelayMs);
      }
    }
  }

  private async reconcileLaneFromRpc(lane: CommitmentLane): Promise<void> {
    while (!this.closed && lane.sessionAlive) {
      const version = lane.registryVersion;
      const accountIds = lane.subscriptionRegistry.snapshot();
      const transport = lane.transport;
      if (!transport) {
        throw new Error("account-sync transport missing during reconciliation");
      }

      await transport.setTrackedAccounts(accountIds, lane.commitment);
      try {
        const refreshedVersion = await this.refreshLaneFromRpc(lane);
        if (refreshedVersion !== version) {
          continue;
        }
      } catch (error: unknown) {
        if (isAbortError(error)) {
          throw error;
        }
        this.lastTransportError = toError(error);
        await abortableDelay(
          this.rpcPollIntervalMs,
          lane.abortController.signal
        );
        continue;
      }

      if (version === lane.registryVersion) {
        return;
      }
    }

    throw new Error("account-sync stream disconnected during reconciliation");
  }

  private startPolling(lane: CommitmentLane): void {
    if (this.closed || lane.status === "closed") {
      return;
    }
    this.requestImmediatePoll(lane);
  }

  private stopPolling(lane: CommitmentLane): void {
    lane.pollAgain = false;
    if (lane.pollTimer) {
      clearTimeout(lane.pollTimer);
      lane.pollTimer = null;
    }
  }

  private requestImmediatePoll(lane: CommitmentLane): void {
    if (this.closed || lane.status === "closed") {
      return;
    }
    if (lane.pollTimer) {
      clearTimeout(lane.pollTimer);
      lane.pollTimer = null;
    }
    if (lane.rpcRefreshTask) {
      lane.pollAgain = true;
      this.continuePollingAfterRefresh(lane, lane.rpcRefreshTask);
      return;
    }
    void this.runPoll(lane);
  }

  private continuePollingAfterRefresh(
    lane: CommitmentLane,
    refreshTask: Promise<number>
  ): void {
    if (lane.pollContinuationScheduled) {
      return;
    }

    lane.pollContinuationScheduled = true;
    const continuePolling = () => {
      lane.pollContinuationScheduled = false;
      if (
        this.closed ||
        lane.status === "closed" ||
        lane.status === "streaming" ||
        lane.pollTimer
      ) {
        return;
      }

      lane.pollTimer = setTimeout(() => {
        lane.pollTimer = null;
        void this.runPoll(lane);
      }, 0);
    };
    void refreshTask.then(continuePolling, continuePolling);
  }

  private async runPoll(lane: CommitmentLane): Promise<void> {
    try {
      await this.refreshLaneFromRpc(lane);
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        this.lastTransportError = toError(error);
      }
    } finally {
      if (
        this.closed ||
        lane.status === "closed" ||
        lane.status === "streaming"
      ) {
        return;
      }
      const delayMs = lane.pollAgain ? 0 : this.rpcPollIntervalMs;
      lane.pollAgain = false;
      lane.pollTimer = setTimeout(() => {
        lane.pollTimer = null;
        void this.runPoll(lane);
      }, delayMs);
    }
  }

  private async refreshLaneFromRpc(lane: CommitmentLane): Promise<number> {
    if (lane.rpcRefreshTask) {
      lane.pollAgain = true;
      return lane.rpcRefreshTask;
    }

    const version = lane.registryVersion;
    const accountIds = lane.subscriptionRegistry.snapshot();
    const task = this.hydrateAccounts(lane, accountIds).then(() => version);
    lane.rpcRefreshTask = task;
    try {
      const refreshedVersion = await task;
      if (refreshedVersion === lane.registryVersion) {
        lane.hydratedRegistryVersion = refreshedVersion;
        lane.hydrationRetryDelayMs = this.rpcPollIntervalMs;
        this.cancelHydrationRetry(lane);
      }
      return refreshedVersion;
    } finally {
      if (lane.rpcRefreshTask === task) {
        lane.rpcRefreshTask = null;
      }
    }
  }

  private requestInitialStateHydration(lane: CommitmentLane): void {
    if (this.closed || lane.status !== "streaming") {
      return;
    }

    if (lane.subscriptionRegistry.snapshot().length === 0) {
      lane.hydratedRegistryVersion = lane.registryVersion;
      lane.hydrationRetryDelayMs = this.rpcPollIntervalMs;
      this.cancelHydrationRetry(lane);
      return;
    }

    if (
      lane.hydratedRegistryVersion === lane.registryVersion ||
      lane.initialHydrationTask ||
      lane.hydrationRetryTimer
    ) {
      return;
    }

    const task = this.runInitialHydrationAttempt(lane);
    lane.initialHydrationTask = task;
    void task.finally(() => {
      if (lane.initialHydrationTask === task) {
        lane.initialHydrationTask = null;
      }
      if (
        !this.closed &&
        lane.status === "streaming" &&
        !lane.hydrationRetryTimer &&
        lane.hydratedRegistryVersion !== lane.registryVersion
      ) {
        this.requestInitialStateHydration(lane);
      }
    });
  }

  private async runInitialHydrationAttempt(lane: CommitmentLane): Promise<void> {
    try {
      await this.refreshLaneFromRpc(lane);
    } catch (error: unknown) {
      if (this.closed || lane.status !== "streaming" || isAbortError(error)) {
        return;
      }

      this.lastTransportError = toError(error);
      this.scheduleHydrationRetry(lane);
    }
  }

  private scheduleHydrationRetry(lane: CommitmentLane): void {
    if (
      this.closed ||
      lane.status !== "streaming" ||
      lane.hydrationRetryTimer ||
      lane.subscriptionRegistry.snapshot().length === 0
    ) {
      return;
    }

    const delayMs = lane.hydrationRetryDelayMs;
    const maxDelayMs = Math.max(
      this.rpcPollIntervalMs,
      this.reconnectMaxDelayMs
    );
    lane.hydrationRetryDelayMs = Math.min(delayMs * 2, maxDelayMs);
    lane.hydrationRetryTimer = setTimeout(() => {
      lane.hydrationRetryTimer = null;
      this.requestInitialStateHydration(lane);
    }, delayMs);
  }

  private cancelHydrationRetry(lane: CommitmentLane): void {
    if (!lane.hydrationRetryTimer) {
      return;
    }

    clearTimeout(lane.hydrationRetryTimer);
    lane.hydrationRetryTimer = null;
  }

  private async hydrateAccounts(
    lane: CommitmentLane,
    accountIds: readonly string[]
  ): Promise<void> {
    if (accountIds.length === 0 || lane.abortController.signal.aborted) {
      return;
    }

    const ownershipTokens = new Map(
      accountIds.map((accountId) => [
        accountId,
        lane.ownershipTokenByAccountId.get(accountId)
      ])
    );

    const hydrationContext: InitialStateHydrationContext = {
      accountIds,
      commitment: lane.commitment,
      signal: lane.abortController.signal,
      upsert: (update) => {
        if (
          lane.abortController.signal.aborted ||
          !lane.subscriptionRegistry.has(update.accountId) ||
          lane.ownershipTokenByAccountId.get(update.accountId) !==
            ownershipTokens.get(update.accountId)
        ) {
          return false;
        }
        return lane.accountBuffer.upsert(update);
      },
      remove: (accountId, slot) => {
        if (
          lane.abortController.signal.aborted ||
          !lane.subscriptionRegistry.has(accountId) ||
          lane.ownershipTokenByAccountId.get(accountId) !==
            ownershipTokens.get(accountId)
        ) {
          return false;
        }
        return lane.accountBuffer.remove(accountId, slot);
      }
    };
    await this.initialStatePlugin.hydrate(hydrationContext);
    for (const accountId of accountIds) {
      this.completeHydrationGate(
        lane,
        accountId,
        ownershipTokens.get(accountId)
      );
    }
  }

  private async readAccountsFromRpc(
    lane: CommitmentLane,
    accountIds: readonly string[],
    minContextSlot: number | undefined,
    rpcErrorMessage: string,
    signal: AbortSignal,
    ownershipTokens = new Map<string, AccountOwnershipToken | undefined>(
      accountIds.map((accountId) => [
        accountId,
        lane.ownershipTokenByAccountId.get(accountId)
      ])
    )
  ): Promise<AccountBufferReadResult[]> {
    const resultsByAccountId = new Map<string, AccountBufferObservation>();
    await this.initialStatePlugin.hydrate({
      accountIds,
      commitment: lane.commitment,
      minContextSlot,
      singleRequest: true,
      rpcErrorMessage,
      signal,
      upsert: (update) => {
        if (signal.aborted) {
          return false;
        }
        let result: AccountBufferObservation | null = null;
        if (
          lane.subscriptionRegistry.has(update.accountId) &&
          lane.ownershipTokenByAccountId.get(update.accountId) ===
            ownershipTokens.get(update.accountId)
        ) {
          lane.accountBuffer.upsert(update);
          result = lane.accountBuffer.observe(update.accountId, minContextSlot);
        }
        result ??= {
          kind: "account",
          state: { ...update, updatedAtMs: Date.now() }
        };
        resultsByAccountId.set(update.accountId, result);
        return true;
      },
      remove: (removedAccountId, slot) => {
        if (signal.aborted) {
          return false;
        }
        let result: AccountBufferObservation | null = null;
        if (
          lane.subscriptionRegistry.has(removedAccountId) &&
          lane.ownershipTokenByAccountId.get(removedAccountId) ===
            ownershipTokens.get(removedAccountId)
        ) {
          lane.accountBuffer.remove(removedAccountId, slot);
          result = lane.accountBuffer.observe(removedAccountId, minContextSlot);
        }
        result ??= {
          kind: "missing",
          tombstone: { slot, writeVersion: -1n }
        };
        resultsByAccountId.set(removedAccountId, result);
        return true;
      }
    });

    if (signal.aborted) {
      throw createAbortError();
    }
    if (accountIds.some((accountId) => !resultsByAccountId.has(accountId))) {
      await waitForAbort(signal);
      throw createAbortError();
    }
    for (const accountId of accountIds) {
      this.completeHydrationGate(
        lane,
        accountId,
        ownershipTokens.get(accountId)
      );
    }
    return accountIds.map((accountId) => resultsByAccountId.get(accountId)!);
  }

  private completeHydrationGate(
    lane: CommitmentLane,
    accountId: string,
    ownershipToken: AccountOwnershipToken | undefined
  ): void {
    if (
      !ownershipToken ||
      !lane.subscriptionRegistry.has(accountId) ||
      lane.ownershipTokenByAccountId.get(accountId) !== ownershipToken ||
      lane.hydrationGateByAccountId.get(accountId) !== ownershipToken
    ) {
      return;
    }
    lane.hydrationGateByAccountId.delete(accountId);
    const staged = lane.stagedUpdateByAccountId.get(accountId);
    if (staged && staged.ownershipToken === ownershipToken) {
      lane.accountBuffer.upsert(staged.update);
    }
    lane.stagedUpdateByAccountId.delete(accountId);
  }

  private assertCurrentSession(lane: CommitmentLane, generation: number): void {
    if (
      this.closed ||
      lane.transportGeneration !== generation ||
      !lane.sessionAlive
    ) {
      throw new Error("account-sync stream disconnected while connecting");
    }
  }

  private async enqueueLaneOperation<T>(
    lane: CommitmentLane,
    operation: () => Promise<T>
  ): Promise<T> {
    this.assertOpen();
    const guardedOperation = async () => {
      this.assertOpen();
      return operation();
    };
    const runOperation = lane.operationChain.then(
      guardedOperation,
      guardedOperation
    );
    lane.operationChain = runOperation.then(
      () => undefined,
      () => undefined
    );
    return runOperation;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("account-sync connection is closed");
    }
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timeoutId);
      reject(createAbortError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function observationToPublicValue(
  observation: AccountBufferObservation | null
): BufferedAccountState | null {
  return observation?.kind === "account" ? observation.state : null;
}

function hasActiveRead(lane: CommitmentLane, accountId: string): boolean {
  return (lane.activeReadsByAccountId.get(accountId) ?? 0) > 0;
}

function isNewerDecodedUpdate(
  incoming: DecodedAccountUpdate,
  current: DecodedAccountUpdate
): boolean {
  return (
    incoming.slot > current.slot ||
    (incoming.slot === current.slot &&
      incoming.writeVersion > current.writeVersion)
  );
}

function createAccountLimitError(
  commitment: AccountSyncCommitment,
  limit: number
): Error {
  return new AccountSyncAccountLimitError(commitment, limit);
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`account-sync ${name} must be a positive safe integer`);
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createAbortError(): Error {
  const error = new Error("account-sync operation aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createCloseTimeoutError(timeoutMs: number): Error {
  const error = new Error(`account-sync close timed out after ${timeoutMs}ms`);
  error.name = "AccountSyncCloseTimeoutError";
  return error;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: Error
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(timeoutError), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}
