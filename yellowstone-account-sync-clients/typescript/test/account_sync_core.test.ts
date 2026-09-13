import { describe, expect, it, vi } from "vitest";
import { AccountSyncCore } from "../src/core/account_sync_core";
import type {
  AccountSyncInitialStatePlugin,
  InitialStateHydrationContext
} from "../src/core/initial_state_plugin";
import type { AccountSubscriptionTransport, TransportHandlers } from "../src/core/transport";
import type { AccountSyncCommitment, DecodedAccountUpdate } from "../src/core/types";

class FakeTransport implements AccountSubscriptionTransport {
  public setCalls: Array<{ accountIds: string[]; commitment: AccountSyncCommitment }> = [];
  public closed = false;
  public connectError: Error | null = null;
  public setError: Error | null = null;
  public connectHook: ((signal: AbortSignal) => Promise<void>) | null = null;
  public closeHook: (() => Promise<void>) | null = null;
  private handlers: TransportHandlers | null = null;

  constructor(public readonly commitment: AccountSyncCommitment) {}

  async connect(handlers: TransportHandlers, signal: AbortSignal): Promise<void> {
    this.handlers = handlers;
    if (this.connectError) {
      throw this.connectError;
    }
    await this.connectHook?.(signal);
  }

  async setTrackedAccounts(
    accountIds: readonly string[],
    commitment: AccountSyncCommitment
  ): Promise<void> {
    this.setCalls.push({ accountIds: [...accountIds].sort(), commitment });
    if (this.setError) {
      throw this.setError;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeHook?.();
  }

  emit(update: DecodedAccountUpdate): void {
    this.handlers?.onAccountUpdate(update);
  }

  disconnect(error = new Error("fake stream disconnected")): void {
    this.handlers?.onTransportError(error);
  }
}

class FakeTransportFactory {
  public readonly transports: FakeTransport[] = [];
  public readonly connectErrors: Array<Error | null> = [];
  public readonly connectHooks: Array<
    ((signal: AbortSignal) => Promise<void>) | null
  > = [];
  public readonly closeHooks: Array<(() => Promise<void>) | null> = [];

  create = (commitment: AccountSyncCommitment): FakeTransport => {
    const transport = new FakeTransport(commitment);
    transport.connectError = this.connectErrors.shift() ?? null;
    transport.connectHook = this.connectHooks.shift() ?? null;
    transport.closeHook = this.closeHooks.shift() ?? null;
    this.transports.push(transport);
    return transport;
  };

  byCommitment(commitment: AccountSyncCommitment): FakeTransport {
    const transport = this.transports.find(
      (candidate) => candidate.commitment === commitment
    );
    if (!transport) {
      throw new Error(`missing fake transport for ${commitment}`);
    }

    return transport;
  }
}

class FakeInitialStatePlugin implements AccountSyncInitialStatePlugin {
  public readonly calls: InitialStateHydrationContext[] = [];

  constructor(
    private readonly onHydrate: (
      context: InitialStateHydrationContext
    ) => Promise<void> = async () => {}
  ) {}

  async hydrate(context: InitialStateHydrationContext): Promise<void> {
    this.calls.push(context);
    await this.onHydrate(context);
  }

  callForCommitment(commitment: AccountSyncCommitment): InitialStateHydrationContext {
    const call = this.calls.find((candidate) => candidate.commitment === commitment);
    if (!call) {
      throw new Error(`missing initial state call for ${commitment}`);
    }

    return call;
  }
}

function makeUpdate(partial: Partial<DecodedAccountUpdate>): DecodedAccountUpdate {
  return {
    accountId: partial.accountId ?? "Account1111111111111111111111111111111111",
    lamports: partial.lamports ?? 1n,
    owner: partial.owner ?? "11111111111111111111111111111111",
    executable: partial.executable ?? false,
    rentEpoch: partial.rentEpoch ?? 0n,
    data: partial.data ?? new Uint8Array([1, 2, 3]),
    slot: partial.slot ?? 1n,
    writeVersion: partial.writeVersion ?? 0n
  };
}

describe("AccountSyncCore", () => {
  it("applies initial accounts on startup", async () => {
    const transportFactory = new FakeTransportFactory();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: ["A1", "A2"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100
    });

    await core.ready();
    const transport = transportFactory.byCommitment("confirmed");
    expect(transport.setCalls).toEqual([
      { accountIds: ["A1", "A2"], commitment: "confirmed" }
    ]);
  });

  it("auto-subscribes on cache miss and returns first update", async () => {
    const transportFactory = new FakeTransportFactory();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 2_000
    });

    await core.ready();
    const transport = transportFactory.byCommitment("confirmed");

    const pendingAccount = core.getBufferedAccount("A3");
    for (let attempt = 0; attempt < 10 && transport.setCalls.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(transport.setCalls).toEqual([
      { accountIds: [], commitment: "confirmed" },
      { accountIds: ["A3"], commitment: "confirmed" }
    ]);

    transport.emit(makeUpdate({ accountId: "A3", lamports: 42n, slot: 8n }));
    const resolved = await pendingAccount;
    expect(resolved?.lamports).toBe(42n);
  });

  it("keeps the RPC context slot when RPC reports the account missing", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      context.remove(context.accountIds[0], 44n);
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: false,
      missTimeoutMs: 100
    });

    await core.ready();
    await expect(core.getBufferedAccountObservation("A6")).resolves.toEqual({
      kind: "missing",
      tombstone: { slot: 44n, writeVersion: -1n }
    });
    await expect(core.getBufferedAccount("A6")).resolves.toBeNull();
    expect(initialStatePlugin.calls).toHaveLength(2);
    expect(initialStatePlugin.calls[0]).toMatchObject({
      accountIds: ["A6"],
      commitment: "confirmed"
    });
    expect(transportFactory.byCommitment("confirmed").setCalls).toEqual([
      { accountIds: [], commitment: "confirmed" }
    ]);
  });

  it("uses one-time RPC without subscribing when auto-subscribe is disabled", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      context.upsert(
        makeUpdate({ accountId: context.accountIds[0], lamports: 66n, slot: 45n })
      );
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: false,
      missTimeoutMs: 100
    });

    await core.ready();
    const account = await core.getBufferedAccount("A7", "confirmed", {
      minContextSlot: 40
    });

    expect(account?.lamports).toBe(66n);
    expect(initialStatePlugin.calls[0].minContextSlot).toBe(40);
    expect(transportFactory.byCommitment("confirmed").setCalls).toEqual([
      { accountIds: [], commitment: "confirmed" }
    ]);
  });

  it("reads unresolved batches with one RPC request and keeps input order", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      for (const accountId of context.accountIds) {
        if (accountId === "A9") {
          context.upsert(makeUpdate({ accountId, lamports: 99n, slot: 50n }));
        } else {
          context.remove(accountId, 50n);
        }
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: false,
      missTimeoutMs: 100
    });

    await core.ready();
    const accounts = await core.getBufferedAccounts(["A9", "A10", "A9"]);

    expect(accounts.map((account) => account?.lamports ?? null)).toEqual([
      99n,
      null,
      99n
    ]);
    expect(initialStatePlugin.calls).toHaveLength(1);
    expect(initialStatePlugin.calls[0]).toMatchObject({
      accountIds: ["A9", "A10", "A9"],
      singleRequest: true
    });
  });

  it("expires read-created subscriptions and releases their state", async () => {
    const transportFactory = new FakeTransportFactory();
    let rpcReads = 0;
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      rpcReads += 1;
      for (const accountId of context.accountIds) {
        context.upsert(makeUpdate({ accountId, lamports: BigInt(rpcReads) }));
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      dynamicSubscriptionTtlMs: 10
    });

    await core.ready();
    await core.getBufferedAccount("A11");
    const transport = transportFactory.byCommitment("confirmed");
    await waitFor(
      () =>
        transport.setCalls.length >= 3 &&
        transport.setCalls.at(-1)?.accountIds.length === 0
    );

    const callsBeforeSecondRead = initialStatePlugin.calls.length;
    await core.getBufferedAccount("A11");
    expect(initialStatePlugin.calls.length).toBeGreaterThan(callsBeforeSecondRead);
    await core.close();
  });

  it("renews a lease when the account is read again", async () => {
    vi.useFakeTimers();
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      for (const accountId of context.accountIds) {
        context.upsert(makeUpdate({ accountId }));
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      dynamicSubscriptionTtlMs: 50
    });

    try {
      await core.ready();
      await core.getBufferedAccount("A11-renewed");
      await vi.advanceTimersByTimeAsync(40);
      await core.getBufferedAccount("A11-renewed");
      await vi.advanceTimersByTimeAsync(40);

      expect(
        transportFactory.byCommitment("confirmed").setCalls.at(-1)?.accountIds
      ).toEqual(["A11-renewed"]);

      await vi.advanceTimersByTimeAsync(10);
      expect(
        transportFactory.byCommitment("confirmed").setCalls.at(-1)?.accountIds
      ).toEqual([]);
      await core.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expire pinned accounts", async () => {
    const transportFactory = new FakeTransportFactory();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: ["A12"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      dynamicSubscriptionTtlMs: 5
    });

    await core.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transportFactory.byCommitment("confirmed").setCalls).toEqual([
      { accountIds: ["A12"], commitment: "confirmed" }
    ]);
    await core.close();
  });

  it("promotes a read lease to a pinned account", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      for (const accountId of context.accountIds) {
        context.upsert(makeUpdate({ accountId }));
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      dynamicSubscriptionTtlMs: 10
    });

    await core.ready();
    await core.getBufferedAccount("A12-promoted");
    await core.addTrackedAccounts(["A12-promoted"]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      transportFactory.byCommitment("confirmed").setCalls.at(-1)?.accountIds
    ).toEqual(["A12-promoted"]);
    await core.close();
  });

  it("does not accept late stream state after ownership is removed", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      if (context.singleRequest) {
        context.remove(context.accountIds[0], 30n);
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A12-removed"],
      autoSubscribeOnMiss: false,
      missTimeoutMs: 100
    });

    await core.ready();
    const transport = transportFactory.byCommitment("confirmed");
    transport.emit(makeUpdate({ accountId: "A12-removed", lamports: 1n }));
    await core.removeTrackedAccounts(["A12-removed"]);
    transport.emit(
      makeUpdate({ accountId: "A12-removed", lamports: 999n, slot: 31n })
    );

    await expect(core.getBufferedAccount("A12-removed")).resolves.toBeNull();
    expect(
      initialStatePlugin.calls.some((call) => call.singleRequest === true)
    ).toBe(true);
    await core.close();
  });

  it("clears cached state and reports invalidation when an account is removed", async () => {
    const transportFactory = new FakeTransportFactory();
    const invalidated = vi.fn();
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      if (context.singleRequest) {
        context.upsert(
          makeUpdate({ accountId: context.accountIds[0], lamports: 2n, slot: 2n })
        );
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A12-invalidated"],
      autoSubscribeOnMiss: false,
      missTimeoutMs: 100,
      onAccountsInvalidated: invalidated
    });

    await core.ready();
    const transport = transportFactory.byCommitment("confirmed");
    transport.emit(
      makeUpdate({ accountId: "A12-invalidated", lamports: 1n, slot: 1n })
    );
    expect((await core.getBufferedAccount("A12-invalidated"))?.lamports).toBe(1n);

    await core.removeTrackedAccounts(["A12-invalidated"]);
    const account = await core.getBufferedAccount("A12-invalidated");

    expect(account?.lamports).toBe(2n);
    expect(invalidated).toHaveBeenCalledWith(
      ["A12-invalidated"],
      "confirmed"
    );
    await core.close();
  });

  it("removes stream ownership while an RPC-backed read is active", async () => {
    const transportFactory = new FakeTransportFactory();
    let releaseRpc: (() => void) | undefined;
    const rpcGate = new Promise<void>((resolve) => {
      releaseRpc = resolve;
    });
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      if (!context.singleRequest) {
        return;
      }
      await rpcGate;
      context.upsert(
        makeUpdate({ accountId: context.accountIds[0], lamports: 50n, slot: 50n })
      );
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A12-active-remove"],
      autoSubscribeOnMiss: false,
      missTimeoutMs: 2_000
    });

    await core.ready();
    const pendingRead = core.getBufferedAccount("A12-active-remove");
    await waitFor(() =>
      initialStatePlugin.calls.some((call) => call.singleRequest === true)
    );
    await core.removeTrackedAccounts(["A12-active-remove"]);
    const transport = transportFactory.byCommitment("confirmed");
    expect(transport.setCalls.at(-1)?.accountIds).toEqual([]);

    transport.emit(
      makeUpdate({ accountId: "A12-active-remove", lamports: 999n, slot: 999n })
    );
    releaseRpc?.();
    expect((await pendingRead)?.lamports).toBe(50n);
    await core.close();
  });

  it("keeps batch order when setAccounts removes an account during the read", async () => {
    const transportFactory = new FakeTransportFactory();
    let releaseRpc: (() => void) | undefined;
    const rpcGate = new Promise<void>((resolve) => {
      releaseRpc = resolve;
    });
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      if (!context.singleRequest) {
        return;
      }
      await rpcGate;
      for (const accountId of context.accountIds) {
        context.upsert(
          makeUpdate({
            accountId,
            lamports: accountId === "A12-batch-keep" ? 10n : 20n,
            slot: 50n
          })
        );
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A12-batch-keep", "A12-batch-remove"],
      autoSubscribeOnMiss: false,
      missTimeoutMs: 2_000
    });

    await core.ready();
    const pendingRead = core.getBufferedAccounts([
      "A12-batch-remove",
      "A12-batch-keep"
    ]);
    await waitFor(() =>
      initialStatePlugin.calls.some((call) => call.singleRequest === true)
    );
    await core.setTrackedAccounts(["A12-batch-keep"]);
    transportFactory.byCommitment("confirmed").emit(
      makeUpdate({ accountId: "A12-batch-remove", lamports: 999n, slot: 999n })
    );
    releaseRpc?.();

    expect((await pendingRead).map((account) => account?.lamports)).toEqual([
      20n,
      10n
    ]);
    expect(
      transportFactory.byCommitment("confirmed").setCalls.at(-1)?.accountIds
    ).toEqual(["A12-batch-keep"]);
    await core.close();
  });

  it("does not let old hydration restore removed state", async () => {
    const transportFactory = new FakeTransportFactory();
    let oldHydration: InitialStateHydrationContext | null = null;
    let releaseHydration: (() => void) | undefined;
    const hydrationGate = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      if (context.singleRequest) {
        context.upsert(
          makeUpdate({ accountId: context.accountIds[0], lamports: 60n, slot: 60n })
        );
        return;
      }
      oldHydration = context;
      await hydrationGate;
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A12-old-hydration"],
      autoSubscribeOnMiss: false,
      missTimeoutMs: 100
    });

    await core.ready();
    await waitFor(() => oldHydration !== null);
    await core.removeTrackedAccounts(["A12-old-hydration"]);
    const staleAccepted = oldHydration!.upsert(
      makeUpdate({ accountId: "A12-old-hydration", lamports: 999n, slot: 999n })
    );
    releaseHydration?.();

    expect(staleAccepted).toBe(false);
    expect((await core.getBufferedAccount("A12-old-hydration"))?.lamports).toBe(
      60n
    );
    await core.close();
  });

  it("hydrates a re-added account before exposing staged stream state", async () => {
    const transportFactory = new FakeTransportFactory();
    let blockBackgroundHydration = false;
    let releaseHydration: (() => void) | undefined;
    const hydrationGate = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      if (context.singleRequest) {
        context.upsert(
          makeUpdate({ accountId: context.accountIds[0], lamports: 20n, slot: 20n })
        );
        return;
      }
      if (blockBackgroundHydration) {
        await hydrationGate;
        context.upsert(
          makeUpdate({ accountId: context.accountIds[0], lamports: 20n, slot: 20n })
        );
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A12-readded"],
      autoSubscribeOnMiss: false,
      missTimeoutMs: 100
    });

    await core.ready();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const transport = transportFactory.byCommitment("confirmed");
    transport.emit(
      makeUpdate({ accountId: "A12-readded", lamports: 10n, slot: 10n })
    );
    await core.removeTrackedAccounts(["A12-readded"]);

    blockBackgroundHydration = true;
    await core.addTrackedAccounts(["A12-readded"]);
    transport.emit(
      makeUpdate({ accountId: "A12-readded", lamports: 11n, slot: 11n })
    );
    expect((await core.getBufferedAccount("A12-readded"))?.lamports).toBe(20n);

    transport.emit(
      makeUpdate({ accountId: "A12-readded", lamports: 21n, slot: 21n })
    );
    expect((await core.getBufferedAccount("A12-readded"))?.lamports).toBe(21n);
    releaseHydration?.();
    await core.close();
  });

  it("adds a read-created subscription alongside pinned accounts", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      if (context.singleRequest) {
        context.upsert(makeUpdate({ accountId: context.accountIds[0], lamports: 13n }));
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A12"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100
    });

    await core.ready();
    const account = await core.getBufferedAccount("A13");
    expect(account?.lamports).toBe(13n);
    expect(transportFactory.byCommitment("confirmed").setCalls).toEqual([
      { accountIds: ["A12"], commitment: "confirmed" },
      { accountIds: ["A12", "A13"], commitment: "confirmed" }
    ]);
    await core.close();
  });

  it("keeps subscriptions for concurrent reads", async () => {
    const transportFactory = new FakeTransportFactory();
    let releaseFirstRead: (() => void) | undefined;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      if (!context.singleRequest) {
        return;
      }
      const accountId = context.accountIds[0];
      if (accountId === "A13-active") {
        await firstReadGate;
      }
      context.upsert(makeUpdate({ accountId }));
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 2_000
    });

    await core.ready();
    const firstRead = core.getBufferedAccount("A13-active");
    await waitFor(
      () =>
        transportFactory.byCommitment("confirmed").setCalls.at(-1)?.accountIds[0] ===
        "A13-active"
    );
    await core.getBufferedAccount("A13-rpc-only");

    expect(
      transportFactory.byCommitment("confirmed").setCalls.at(-1)?.accountIds
    ).toEqual(["A13-active", "A13-rpc-only"]);
    releaseFirstRead?.();
    await firstRead;
    await core.close();
  });

  it("keeps all read-created subscriptions until their leases expire", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      for (const accountId of context.accountIds) {
        context.upsert(makeUpdate({ accountId }));
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      dynamicSubscriptionTtlMs: 2_000
    });

    await core.ready();
    await core.getBufferedAccount("A14");
    await new Promise((resolve) => setTimeout(resolve, 2));
    await core.getBufferedAccount("A15");
    await core.getBufferedAccount("A16");

    expect(
      transportFactory.byCommitment("confirmed").setCalls.at(-1)?.accountIds
    ).toEqual(["A14", "A15", "A16"]);
    await core.close();
  });

  it("accepts additional pinned accounts", async () => {
    const transportFactory = new FakeTransportFactory();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: ["A17"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100
    });

    await core.ready();
    await core.addTrackedAccounts(["A18"]);
    expect(transportFactory.byCommitment("confirmed").setCalls).toEqual([
      { accountIds: ["A17"], commitment: "confirmed" },
      { accountIds: ["A17", "A18"], commitment: "confirmed" }
    ]);
    await core.close();
  });

  it("closes an unused non-default commitment lane and recreates it", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      for (const accountId of context.accountIds) {
        context.upsert(makeUpdate({ accountId }));
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      dynamicSubscriptionTtlMs: 10
    });

    await core.ready();
    await core.getBufferedAccount("A19", "finalized");
    const firstFinalized = transportFactory.transports.find(
      (transport) => transport.commitment === "finalized"
    );
    await waitFor(() => firstFinalized?.closed === true);

    await core.getBufferedAccount("A19", "finalized");
    expect(
      transportFactory.transports.filter(
        (transport) => transport.commitment === "finalized"
      )
    ).toHaveLength(2);
    await core.close();
  });

  it("removes pinned accounts from a non-default commitment lane", async () => {
    const transportFactory = new FakeTransportFactory();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100
    });

    await core.ready();
    await core.addTrackedAccounts(["A20"], "finalized");
    const finalizedTransport = transportFactory.transports.find(
      (transport) => transport.commitment === "finalized"
    );
    await core.removeTrackedAccounts(["A20"], "finalized");

    expect(finalizedTransport?.setCalls.at(-1)).toEqual({
      accountIds: [],
      commitment: "finalized"
    });
    expect(finalizedTransport?.closed).toBe(true);
    await core.close();
  });

  it("preserves a one-time RPC failure", async () => {
    const transportFactory = new FakeTransportFactory();
    const rpcError = Object.assign(new Error("rpc failed"), {
      name: "SolanaJSONRPCError",
      code: -32016
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(async () => {
        throw rpcError;
      }),
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: false,
      missTimeoutMs: 100
    });

    await core.ready();
    await expect(core.getBufferedAccount("A8")).rejects.toBe(rpcError);
  });

  it("supports removing accounts at runtime", async () => {
    const transportFactory = new FakeTransportFactory();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: ["A1", "A2", "A3"],
      autoSubscribeOnMiss: false,
      missTimeoutMs: 100
    });

    await core.ready();
    const transport = transportFactory.byCommitment("confirmed");
    await core.removeTrackedAccounts(["A2"]);

    expect(transport.setCalls).toEqual([
      { accountIds: ["A1", "A2", "A3"], commitment: "confirmed" },
      { accountIds: ["A1", "A3"], commitment: "confirmed" }
    ]);
  });

  it("uses configured commitment for startup and runtime subscription updates", async () => {
    const transportFactory = new FakeTransportFactory();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "finalized",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100
    });

    await core.ready();
    const transport = transportFactory.byCommitment("finalized");
    await core.addTrackedAccounts(["A2"]);

    expect(transport.setCalls).toEqual([
      { accountIds: ["A1"], commitment: "finalized" },
      { accountIds: ["A1", "A2"], commitment: "finalized" }
    ]);
  });

  it("opens a separate commitment lane for getBufferedAccount with another commitment", async () => {
    const transportFactory = new FakeTransportFactory();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 2_000
    });

    await core.ready();
    const pendingFinalizedAccount = core.getBufferedAccount("A1", "finalized");
    for (
      let attempt = 0;
      attempt < 10 &&
      (transportFactory.transports.length < 2 ||
        transportFactory.transports[1].setCalls.length === 0);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const confirmedTransport = transportFactory.byCommitment("confirmed");
    const finalizedTransport = transportFactory.byCommitment("finalized");
    expect(confirmedTransport.setCalls).toEqual([
      { accountIds: ["A1"], commitment: "confirmed" }
    ]);
    expect(finalizedTransport.setCalls).toEqual([
      { accountIds: [], commitment: "finalized" },
      { accountIds: ["A1"], commitment: "finalized" }
    ]);

    confirmedTransport.emit(makeUpdate({ accountId: "A1", lamports: 11n, slot: 8n }));
    finalizedTransport.emit(makeUpdate({ accountId: "A1", lamports: 42n, slot: 7n }));

    const finalizedAccount = await pendingFinalizedAccount;
    expect(finalizedAccount?.lamports).toBe(42n);

    const confirmedAccount = await core.getBufferedAccount("A1", "confirmed");
    expect(confirmedAccount?.lamports).toBe(11n);
  });

  it("hydrates separate commitment lanes with each lane commitment", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 2_000
    });

    await core.ready();
    const pendingFinalizedAccount = core.getBufferedAccount("A1", "finalized");
    for (
      let attempt = 0;
      attempt < 10 && initialStatePlugin.calls.length < 2;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(initialStatePlugin.calls.map((call) => call.commitment)).toContain(
      "confirmed"
    );
    expect(initialStatePlugin.calls.map((call) => call.commitment)).toContain(
      "finalized"
    );
    expect(initialStatePlugin.callForCommitment("confirmed").accountIds).toEqual([
      "A1"
    ]);
    expect(initialStatePlugin.callForCommitment("finalized").accountIds).toEqual([
      "A1"
    ]);

    const finalizedTransport = transportFactory.byCommitment("finalized");
    finalizedTransport.emit(makeUpdate({ accountId: "A1", slot: 9n }));
    await pendingFinalizedAccount;
  });

  it("starts initial state hydration without blocking subscription startup", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(
      () => new Promise(() => {})
    );
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100
    });

    await core.ready();

    const transport = transportFactory.byCommitment("confirmed");
    expect(initialStatePlugin.calls).toHaveLength(1);
    expect(initialStatePlugin.calls[0].accountIds).toEqual(["A1"]);
    expect(transport.setCalls).toEqual([
      { accountIds: ["A1"], commitment: "confirmed" }
    ]);
  });

  it("keeps streamed state when initial hydration arrives at the same slot", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100
    });

    await core.ready();
    const transport = transportFactory.byCommitment("confirmed");
    transport.emit(makeUpdate({ accountId: "A1", lamports: 42n, slot: 8n }));

    initialStatePlugin.calls[0].upsert(
      makeUpdate({
        accountId: "A1",
        lamports: 1n,
        slot: 8n,
        writeVersion: -1n
      })
    );

    const account = await core.getBufferedAccount("A1", "confirmed");
    expect(account?.lamports).toBe(42n);
  });

  it("keeps streamed state when older initial hydration arrives later", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100
    });

    await core.ready();
    const transport = transportFactory.byCommitment("confirmed");
    transport.emit(makeUpdate({ accountId: "A1", lamports: 42n, slot: 8n }));

    initialStatePlugin.calls[0].upsert(
      makeUpdate({
        accountId: "A1",
        lamports: 1n,
        slot: 7n,
        writeVersion: -1n
      })
    );

    const account = await core.getBufferedAccount("A1", "confirmed");
    expect(account?.lamports).toBe(42n);
    expect(account?.slot).toBe(8n);
  });

  it("uses newer streamed state after initial hydration snapshot", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100
    });

    await core.ready();
    initialStatePlugin.calls[0].upsert(
      makeUpdate({
        accountId: "A1",
        lamports: 1n,
        slot: 7n,
        writeVersion: -1n
      })
    );

    const transport = transportFactory.byCommitment("confirmed");
    transport.emit(makeUpdate({ accountId: "A1", lamports: 42n, slot: 8n }));

    const account = await core.getBufferedAccount("A1", "confirmed");
    expect(account?.lamports).toBe(42n);
    expect(account?.slot).toBe(8n);
  });

  it("contains initial hydration failures without stopping stream updates", async () => {
    const transportFactory = new FakeTransportFactory();
    const hydrationError = new Error("initial hydration failed");
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(async () => {
        throw hydrationError;
      }),
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 2_000,
      rpcPollIntervalMs: 20
    });

    await core.ready();
    for (
      let attempt = 0;
      attempt < 10 && core.getLastTransportError() === null;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const transport = transportFactory.byCommitment("confirmed");
    const pendingAccount = core.getBufferedAccount("A1", "confirmed");
    transport.emit(makeUpdate({ accountId: "A1", lamports: 42n, slot: 8n }));
    const account = await pendingAccount;

    expect(account?.lamports).toBe(42n);
    expect(core.getLastTransportError()).toBe(hydrationError);
    expect(transport.setCalls).toEqual([
      { accountIds: ["A1"], commitment: "confirmed" }
    ]);
    await core.close();
  });

  it("retries failed initial hydration while streaming", async () => {
    const transportFactory = new FakeTransportFactory();
    const hydrationError = new Error("initial hydration failed");
    let hydrationAttempts = 0;
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      hydrationAttempts += 1;
      if (hydrationAttempts === 1) {
        throw hydrationError;
      }

      context.upsert(
        makeUpdate({
          accountId: "A1",
          lamports: 91n,
          slot: 9n,
          writeVersion: -1n
        })
      );
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 2_000,
      rpcPollIntervalMs: 1,
      reconnectMaxDelayMs: 10
    });

    await core.ready();
    const pendingAccount = core.getBufferedAccount("A1", "confirmed");
    await waitFor(() => hydrationAttempts >= 2);

    const account = await pendingAccount;
    expect(account?.lamports).toBe(91n);
    expect(hydrationAttempts).toBe(2);
    expect(core.getLastTransportError()).toBe(hydrationError);
    await core.close();
  });

  it("queues one fresh hydration when subscriptions change during a request", async () => {
    const transportFactory = new FakeTransportFactory();
    let releaseFirstHydration: (() => void) | undefined;
    const firstHydrationGate = new Promise<void>((resolve) => {
      releaseFirstHydration = resolve;
    });
    let hydrationAttempts = 0;
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      hydrationAttempts += 1;
      if (hydrationAttempts === 1) {
        await firstHydrationGate;
        return;
      }

      context.upsert(
        makeUpdate({
          accountId: "A2",
          lamports: 92n,
          slot: 10n,
          writeVersion: -1n
        })
      );
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 2_000,
      rpcPollIntervalMs: 1
    });

    await core.ready();
    await waitFor(() => hydrationAttempts === 1);
    await core.addTrackedAccounts(["A2"]);
    expect(hydrationAttempts).toBe(1);

    releaseFirstHydration?.();
    await waitFor(() => hydrationAttempts === 2);
    expect(initialStatePlugin.calls[1].accountIds).toEqual(["A1", "A2"]);

    const account = await core.getBufferedAccount("A2", "confirmed");
    expect(account?.lamports).toBe(92n);
    await core.close();
  });

  it("cancels hydration retries when no tracked accounts remain", async () => {
    const transportFactory = new FakeTransportFactory();
    const hydrationError = new Error("initial hydration failed");
    let hydrationAttempts = 0;
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(async () => {
        hydrationAttempts += 1;
        throw hydrationError;
      }),
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      rpcPollIntervalMs: 20
    });

    await core.ready();
    await waitFor(() => core.getLastTransportError() === hydrationError);
    await core.removeTrackedAccounts(["A1"]);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(hydrationAttempts).toBe(1);
    await core.close();
  });

  it("hands an active streaming hydration over to polling after disconnect", async () => {
    const transportFactory = new FakeTransportFactory();
    let releaseFirstHydration: (() => void) | undefined;
    const firstHydrationGate = new Promise<void>((resolve) => {
      releaseFirstHydration = resolve;
    });
    let hydrationAttempts = 0;
    const initialStatePlugin = new FakeInitialStatePlugin(async () => {
      hydrationAttempts += 1;
      if (hydrationAttempts === 1) {
        await firstHydrationGate;
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      rpcPollIntervalMs: 5,
      reconnectInitialDelayMs: 100,
      reconnectMaxDelayMs: 100
    });

    await core.ready();
    await waitFor(() => hydrationAttempts === 1);
    transportFactory.byCommitment("confirmed").disconnect();
    releaseFirstHydration?.();

    await waitFor(() => hydrationAttempts >= 2);
    await core.close();
  });

  it("falls back to RPC immediately and reconnects with a full reconciliation", async () => {
    const transportFactory = new FakeTransportFactory();
    let hydrationCount = 0;
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      hydrationCount += 1;
      if (hydrationCount >= 2) {
        context.upsert(
          makeUpdate({ accountId: "A1", lamports: 55n, slot: 55n, writeVersion: -1n })
        );
      }
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 500,
      rpcPollIntervalMs: 20,
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 20
    });

    await core.ready();
    await waitFor(() => initialStatePlugin.calls.length >= 1);
    transportFactory.transports[0].disconnect();

    const account = await core.getBufferedAccount("A1");
    expect(account?.lamports).toBe(55n);
    await waitFor(() => transportFactory.transports.length >= 2);
    await waitFor(() => initialStatePlugin.calls.length >= 3);

    expect(transportFactory.transports[1].setCalls).toContainEqual({
      accountIds: ["A1"],
      commitment: "confirmed"
    });
    expect(initialStatePlugin.calls.at(-1)?.accountIds).toEqual(["A1"]);
    await core.close();
  });

  it("recovers and resends the full set after a subscription write fails", async () => {
    const transportFactory = new FakeTransportFactory();
    const writeError = new Error("subscription write failed");
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      rpcPollIntervalMs: 10,
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 10
    });

    await core.ready();
    transportFactory.transports[0].setError = writeError;
    await core.addTrackedAccounts(["A2"]);

    expect(core.getLastTransportError()).toBe(writeError);
    await waitFor(() => transportFactory.transports.length >= 2);
    await waitFor(() =>
      transportFactory.transports[1].setCalls.some(
        (call) => call.accountIds.join(",") === "A1,A2"
      )
    );
    await core.close();
  });

  it("serves RPC data and retries when the initial stream connection fails", async () => {
    const transportFactory = new FakeTransportFactory();
    transportFactory.connectErrors.push(new Error("initial connect failed"), null);
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      context.upsert(
        makeUpdate({ accountId: "A1", lamports: 88n, slot: 88n, writeVersion: -1n })
      );
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 500,
      rpcPollIntervalMs: 10,
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 10
    });

    await core.ready();
    const account = await core.getBufferedAccount("A1");
    expect(account?.lamports).toBe(88n);
    await waitFor(() => transportFactory.transports.length >= 2);
    expect(transportFactory.transports[1].setCalls).toContainEqual({
      accountIds: ["A1"],
      commitment: "confirmed"
    });
    await core.close();
  });

  it("backs off failed reconnects without blocking RPC-backed reads", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      context.upsert(
        makeUpdate({ accountId: "A1", lamports: 77n, slot: 77n, writeVersion: -1n })
      );
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 500,
      rpcPollIntervalMs: 10,
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 10
    });

    await core.ready();
    transportFactory.connectErrors.push(new Error("retry one failed"), null);
    transportFactory.transports[0].disconnect();

    const account = await core.getBufferedAccount("A1");
    expect(account?.lamports).toBe(77n);
    await waitFor(() => transportFactory.transports.length >= 3);
    expect(transportFactory.transports[1].closed).toBe(true);
    expect(transportFactory.transports[2].setCalls).toContainEqual({
      accountIds: ["A1"],
      commitment: "confirmed"
    });
    await core.close();
  });

  it("does not let reconnect RPC reconciliation overwrite newer stream data", async () => {
    const transportFactory = new FakeTransportFactory();
    let resolveReconciliation: (() => void) | null = null;
    let hydrationCount = 0;
    const initialStatePlugin = new FakeInitialStatePlugin(async (context) => {
      hydrationCount += 1;
      if (hydrationCount < 2) {
        return;
      }
      await new Promise<void>((resolve) => {
        resolveReconciliation = resolve;
      });
      context.upsert(
        makeUpdate({ accountId: "A1", lamports: 19n, slot: 19n, writeVersion: -1n })
      );
    });
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 500,
      rpcPollIntervalMs: 20,
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 10
    });

    await core.ready();
    await waitFor(() => initialStatePlugin.calls.length >= 1);
    transportFactory.transports[0].disconnect();
    await waitFor(() => transportFactory.transports.length >= 2);
    transportFactory.transports[1].emit(
      makeUpdate({ accountId: "A1", lamports: 20n, slot: 20n })
    );
    await waitFor(() => resolveReconciliation !== null);
    const releaseReconciliation = resolveReconciliation as unknown as () => void;
    releaseReconciliation();
    await waitFor(() => hydrationCount >= 2);

    const account = await core.getBufferedAccount("A1");
    expect(account?.lamports).toBe(20n);
    expect(account?.slot).toBe(20n);
    await core.close();
  });

  it("closes while initial transport setup is still pending", async () => {
    const transportFactory = new FakeTransportFactory();
    transportFactory.connectHooks.push(waitUntilAborted);
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      reconnectInitialDelayMs: 1,
      closeTimeoutMs: 100
    });

    await waitFor(() => transportFactory.transports.length === 1);
    await expect(core.close()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(transportFactory.transports).toHaveLength(1);
    expect(transportFactory.transports[0].closed).toBe(true);
  });

  it("bounds close when a transport does not finish closing", async () => {
    const transportFactory = new FakeTransportFactory();
    transportFactory.closeHooks.push(() => new Promise<void>(() => {}));
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      closeTimeoutMs: 5
    });

    await core.ready();
    const firstClose = core.close();
    const secondClose = core.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).rejects.toMatchObject({
      name: "AccountSyncCloseTimeoutError"
    });
    await expect(core.close()).rejects.toMatchObject({
      name: "AccountSyncCloseTimeoutError"
    });
  });

  it("bounds close when a hydration plugin ignores cancellation", async () => {
    const transportFactory = new FakeTransportFactory();
    const initialStatePlugin = new FakeInitialStatePlugin(
      () => new Promise<void>(() => {})
    );
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin,
      commitment: "confirmed",
      initialAccountIds: ["A1"],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100,
      closeTimeoutMs: 5
    });

    await core.ready();
    await waitFor(() => initialStatePlugin.calls.length === 1);

    await expect(core.close()).rejects.toMatchObject({
      name: "AccountSyncCloseTimeoutError"
    });
  });

  it("aborts pending account reads during close", async () => {
    const transportFactory = new FakeTransportFactory();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 2_000,
      closeTimeoutMs: 100
    });

    await core.ready();
    const pendingAccount = core.getBufferedAccount("A1");
    await waitFor(
      () => transportFactory.byCommitment("confirmed").setCalls.length >= 2
    );
    await core.close();

    await expect(pendingAccount).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not let a stuck commitment lane block the default lane", async () => {
    const transportFactory = new FakeTransportFactory();
    transportFactory.connectHooks.push(null, waitUntilAborted);
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 2_000,
      closeTimeoutMs: 100
    });

    await core.ready();
    const blockedRead = core.getBufferedAccount("A1", "finalized");
    await waitFor(() => transportFactory.transports.length === 2);

    await expect(core.addTrackedAccounts(["A2"])).resolves.toBeUndefined();
    await core.close();
    await expect(blockedRead).rejects.toThrow("account-sync connection is closed");
  });

  it("rejects operations started after close", async () => {
    const transportFactory = new FakeTransportFactory();
    const core = new AccountSyncCore({
      transportFactory: transportFactory.create,
      initialStatePlugin: new FakeInitialStatePlugin(),
      commitment: "confirmed",
      initialAccountIds: [],
      autoSubscribeOnMiss: true,
      missTimeoutMs: 100
    });

    await core.ready();
    await core.close();

    await expect(core.addTrackedAccounts(["A1"])).rejects.toThrow(
      "account-sync connection is closed"
    );
    await expect(core.getBufferedAccount("A1")).rejects.toThrow(
      "account-sync connection is closed"
    );
  });
});

function waitUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(makeAbortError());
  }

  return new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(makeAbortError()), {
      once: true
    });
  });
}

function makeAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
