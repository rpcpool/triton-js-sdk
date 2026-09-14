import type { BufferedAccountState, DecodedAccountUpdate } from "./types";

interface PendingWaiter {
  resolve: (result: AccountBufferReadResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  minContextSlot?: number;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export interface AccountTombstone {
  slot: bigint;
  writeVersion: bigint;
}

export type AccountBufferObservation =
  | { kind: "account"; state: BufferedAccountState }
  | { kind: "missing"; tombstone: AccountTombstone };

export type AccountBufferReadResult =
  | AccountBufferObservation
  | { kind: "timeout" };

const RPC_SNAPSHOT_WRITE_VERSION = -1n;

// What: In-memory latest-value store for account states.
// Why: `getAccountInfo` must resolve from local buffered data without RPC polling.
// How: Keep per-account latest snapshot and waiters for first-seen updates.
export class AccountBuffer {
  private readonly statesByAccountId = new Map<string, BufferedAccountState>();
  private readonly tombstonesByAccountId = new Map<string, AccountTombstone>();
  private readonly pendingWaitersByAccountId = new Map<string, Set<PendingWaiter>>();

  // What: Reads the latest buffered state for an account.
  // Why: Fast-path for `getAccountInfo` when data is already in cache.
  // How: Lookup by base58 account id in map.
  public get(
    accountId: string,
    minContextSlot?: number
  ): BufferedAccountState | null {
    const state = this.statesByAccountId.get(accountId) ?? null;
    if (!state || !satisfiesMinContextSlot(state, minContextSlot)) {
      return null;
    }

    return state;
  }

  public observe(
    accountId: string,
    minContextSlot?: number
  ): AccountBufferObservation | null {
    const state = this.get(accountId, minContextSlot);
    if (state) {
      return { kind: "account", state };
    }

    const tombstone = this.tombstonesByAccountId.get(accountId);
    if (tombstone && satisfiesMinContextSlot(tombstone, minContextSlot)) {
      return { kind: "missing", tombstone };
    }

    return null;
  }

  public delete(accountId: string): boolean {
    const deletedState = this.statesByAccountId.delete(accountId);
    const deletedTombstone = this.tombstonesByAccountId.delete(accountId);
    return deletedState || deletedTombstone;
  }

  // What: Inserts or updates account state if update is not stale.
  // Why: Stream can deliver out-of-order or duplicate updates.
  // How: Compare slot/writeVersion and keep only freshest update.
  public upsert(update: DecodedAccountUpdate): boolean {
    const previous = this.statesByAccountId.get(update.accountId);
    if (previous && !isNewerOrEqual(update, previous)) {
      return false;
    }
    const tombstone = this.tombstonesByAccountId.get(update.accountId);
    if (tombstone && !isNewerOrEqual(update, tombstone)) {
      return false;
    }

    const nextState: BufferedAccountState = {
      ...update,
      updatedAtMs: Date.now()
    };
    this.tombstonesByAccountId.delete(update.accountId);
    this.statesByAccountId.set(update.accountId, nextState);
    this.resolvePendingWaiters(update.accountId, nextState);
    return true;
  }

  // What: Records that RPC observed an account as absent at a particular slot.
  // Why: Polling must not keep serving stale data after an account is closed.
  // How: Store a slot-ordered tombstone and reject older stream updates.
  public remove(accountId: string, slot: bigint): boolean {
    const incoming: AccountTombstone = {
      slot,
      writeVersion: RPC_SNAPSHOT_WRITE_VERSION
    };
    const previous = this.statesByAccountId.get(accountId);
    if (previous && !isNewerOrEqual(incoming, previous)) {
      return false;
    }
    const previousTombstone = this.tombstonesByAccountId.get(accountId);
    if (previousTombstone && !isNewerOrEqual(incoming, previousTombstone)) {
      return false;
    }

    this.statesByAccountId.delete(accountId);
    this.tombstonesByAccountId.set(accountId, incoming);
    this.resolvePendingWaitersWithNull(accountId, slot);
    return true;
  }

  // What: Waits until an account receives a buffered update.
  // Why: Auto-subscribe-on-miss flow needs to block briefly for first state.
  // How: Register a timeout-bound waiter and resolve when matching upsert arrives.
  public waitForAccount(
    accountId: string,
    timeoutMs: number,
    minContextSlot?: number,
    signal?: AbortSignal
  ): Promise<AccountBufferReadResult> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    const existing = this.observe(accountId, minContextSlot);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<AccountBufferReadResult>((resolve, reject) => {
      const waitersForAccount =
        this.pendingWaitersByAccountId.get(accountId) ?? new Set<PendingWaiter>();

      const waiter: PendingWaiter = {
        minContextSlot,
        resolve,
        signal,
        timeoutId: setTimeout(() => {
          waitersForAccount.delete(waiter);
          removeAbortListener(waiter);
          if (waitersForAccount.size === 0) {
            this.pendingWaitersByAccountId.delete(accountId);
          }
          resolve({ kind: "timeout" });
        }, timeoutMs)
      };

      if (signal) {
        waiter.abortHandler = () => {
          clearTimeout(waiter.timeoutId);
          waitersForAccount.delete(waiter);
          removeAbortListener(waiter);
          if (waitersForAccount.size === 0) {
            this.pendingWaitersByAccountId.delete(accountId);
          }
          reject(createAbortError());
        };
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }

      waitersForAccount.add(waiter);
      this.pendingWaitersByAccountId.set(accountId, waitersForAccount);
    });
  }

  private resolvePendingWaiters(
    accountId: string,
    state: BufferedAccountState
  ): void {
    const waitersForAccount = this.pendingWaitersByAccountId.get(accountId);
    if (!waitersForAccount) {
      return;
    }

    for (const waiter of [...waitersForAccount]) {
      if (!satisfiesMinContextSlot(state, waiter.minContextSlot)) {
        continue;
      }

      clearTimeout(waiter.timeoutId);
      removeAbortListener(waiter);
      waitersForAccount.delete(waiter);
      waiter.resolve({ kind: "account", state });
    }

    if (waitersForAccount.size === 0) {
      this.pendingWaitersByAccountId.delete(accountId);
    }
  }

  private resolvePendingWaitersWithNull(accountId: string, slot: bigint): void {
    const waitersForAccount = this.pendingWaitersByAccountId.get(accountId);
    if (!waitersForAccount) {
      return;
    }

    for (const waiter of [...waitersForAccount]) {
      if (waiter.minContextSlot !== undefined && slot < BigInt(waiter.minContextSlot)) {
        continue;
      }

      clearTimeout(waiter.timeoutId);
      removeAbortListener(waiter);
      waitersForAccount.delete(waiter);
      waiter.resolve({
        kind: "missing",
        tombstone: { slot, writeVersion: RPC_SNAPSHOT_WRITE_VERSION }
      });
    }

    if (waitersForAccount.size === 0) {
      this.pendingWaitersByAccountId.delete(accountId);
    }
  }
}

function removeAbortListener(waiter: PendingWaiter): void {
  if (waiter.signal && waiter.abortHandler) {
    waiter.signal.removeEventListener("abort", waiter.abortHandler);
  }
}

function createAbortError(): Error {
  const error = new Error("account-sync operation aborted");
  error.name = "AbortError";
  return error;
}

function satisfiesMinContextSlot(
  state: { slot: bigint },
  minContextSlot: number | undefined
): boolean {
  if (minContextSlot === undefined) {
    return true;
  }

  return state.slot >= BigInt(minContextSlot);
}

function isNewerOrEqual(
  incoming: { slot: bigint; writeVersion: bigint },
  existing: { slot: bigint; writeVersion: bigint }
): boolean {
  if (incoming.slot > existing.slot) {
    return true;
  }

  if (incoming.slot < existing.slot) {
    return false;
  }

  return incoming.writeVersion >= existing.writeVersion;
}
