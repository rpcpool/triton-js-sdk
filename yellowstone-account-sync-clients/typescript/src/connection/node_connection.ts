import {
  Connection as Web3JsConnection,
  PublicKey,
  type AccountInfo,
  type Commitment,
  type GetAccountInfoConfig,
  type GetMultipleAccountsConfig,
  type ParsedAccountData,
  type RpcResponseAndContext
} from "@solana/web3.js";
import NodeWebSocket from "ws";
import {
  AccountParseContextCache,
  bufferedAccountToEncodingInput,
  encodeAccount,
  toWeb3JsParsedAccountInfo
} from "../account_encoding";
import {
  AccountSyncCore,
  type AccountSyncAccountObservation
} from "../core/account_sync_core";
import {
  AccountSyncTransports,
  type AccountSyncCommitment,
  type BufferedAccountState,
  type NodeCommitmentOrConfig,
  type NodeAccountSyncConnectionConfig,
  type NodeSubscriptionTransport,
  type ResolvedGetAccountInfoOptions
} from "../core/types";
import { RpcInitialStatePlugin } from "../plugins/rpc_initial_state";
import { GrpcAccountSubscriptionTransport } from "../transport/grpc";
import { WsAccountSubscriptionTransport, type WebSocketLike } from "../transport/ws";
import {
  buildWeb3JsConnectionCtorArg,
  deriveWebSocketEndpoint,
  normalizeAccountIds,
  resolveAccountSyncSettings,
  resolveGetAccountInfoCommitment,
  resolveGetAccountInfoOptions,
  resolveGetMultipleAccountsInfoOptions,
  splitCommitmentAndConfig,
  toWeb3JsContextSlot,
  toWeb3JsAccountInfo
} from "./utils";

// What: web3.js-compatible Connection wrapper for Node runtimes.
// Why: Existing web3.js users should keep familiar constructor and `getAccountInfo` API.
// How: Uses transport-agnostic core and selects grpc/ws by config enum.
export class Connection extends Web3JsConnection {
  private readonly core: AccountSyncCore;
  private readonly accountSyncCommitment: AccountSyncCommitment;
  private readonly accountParseContextCache = new AccountParseContextCache();

  constructor(endpoint: string, commitmentOrConfig?: NodeCommitmentOrConfig) {
    const { commitment, config } =
      splitCommitmentAndConfig<NodeAccountSyncConnectionConfig>(commitmentOrConfig);
    super(endpoint, buildWeb3JsConnectionCtorArg(commitment, config));

    const accountSyncOptions = config.accountSync;
    const transportKind: NodeSubscriptionTransport =
      accountSyncOptions?.transport ?? AccountSyncTransports.WS;
    if (accountSyncOptions?.grpc && transportKind !== AccountSyncTransports.GRPC) {
      throw new Error("accountSync.grpc requires the grpc transport");
    }

    const fallbackWsEndpoint = deriveWebSocketEndpoint(endpoint);
    const fallbackEndpoint =
      transportKind === AccountSyncTransports.GRPC ? endpoint : fallbackWsEndpoint;
    const resolved = resolveAccountSyncSettings(
      accountSyncOptions,
      fallbackEndpoint,
      transportKind,
      commitment
    );

    this.accountSyncCommitment = resolved.commitment;

    this.core = new AccountSyncCore({
      transportFactory: () =>
        resolved.transport === AccountSyncTransports.GRPC
          ? new GrpcAccountSubscriptionTransport(resolved.subscriptionEndpoint, {
              ...resolved.grpc
            })
          : new WsAccountSubscriptionTransport(
              resolved.subscriptionEndpoint,
              (socketEndpoint) =>
                new NodeWebSocket(socketEndpoint) as unknown as WebSocketLike,
              resolved.connectTimeoutMs
            ),
      initialStatePlugin: new RpcInitialStatePlugin({ endpoint }),
      commitment: resolved.commitment,
      initialAccountIds: resolved.initialAccountIds,
      autoSubscribeOnMiss: resolved.autoSubscribeOnMiss,
      missTimeoutMs: resolved.missTimeoutMs,
      rpcPollIntervalMs: resolved.rpcPollIntervalMs,
      reconnectInitialDelayMs: resolved.reconnectInitialDelayMs,
      reconnectMaxDelayMs: resolved.reconnectMaxDelayMs,
      closeTimeoutMs: resolved.closeTimeoutMs,
      dynamicSubscriptionTtlMs: resolved.dynamicSubscriptionTtlMs,
      maxAccountsPerCommitment: resolved.maxAccountsPerCommitment,
      onAccountsInvalidated: (accountIds) => {
        for (const accountId of accountIds) {
          this.accountParseContextCache.delete(accountId);
        }
      }
    });
  }

  public override async getAccountInfoAndContext(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>> {
    const options = resolveGetAccountInfoOptions(
      commitmentOrConfig,
      this.accountSyncCommitment
    );
    const response = await this.getBufferedAccountStateAndContext(publicKey, options);
    return {
      context: response.context,
      value: response.value ? toWeb3JsAccountInfo(response.value, options.dataSlice) : null
    };
  }

  // What: Returns locally buffered account info in web3.js schema.
  // Why: Main SDK objective is replacing polling RPC reads with local cache reads.
  // How: Normalize key, resolve buffered state, map to `AccountInfo<Buffer>`.
  public override async getAccountInfo(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig
  ): Promise<AccountInfo<Buffer> | null> {
    try {
      const response = await this.getAccountInfoAndContext(
        publicKey,
        commitmentOrConfig
      );
      return response.value;
    } catch (error: unknown) {
      throw new Error(
        `failed to get info about account ${publicKey.toBase58()}: ${error}`
      );
    }
  }

  public override async getParsedAccountInfo(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer | ParsedAccountData> | null>> {
    const options = resolveGetAccountInfoOptions(
      commitmentOrConfig,
      this.accountSyncCommitment
    );
    const response = await this.getBufferedAccountStateAndContext(publicKey, options);

    return {
      context: response.context,
      value: response.value
        ? await this.toParsedAccountInfo(response.value, options)
        : null
    };
  }

  // What: Returns locally buffered account info for multiple accounts with context.
  // Why: Match web3.js `getMultipleAccountsInfoAndContext` while using the local cache.
  // How: Resolve each account through the same core path used by `getAccountInfo`.
  public override async getMultipleAccountsInfoAndContext(
    publicKeys: PublicKey[],
    commitmentOrConfig?: Commitment | GetMultipleAccountsConfig
  ): Promise<RpcResponseAndContext<(AccountInfo<Buffer> | null)[]>> {
    const options = resolveGetMultipleAccountsInfoOptions(
      commitmentOrConfig,
      this.accountSyncCommitment
    );
    const response = await this.getBufferedAccountStatesAndContext(
      publicKeys,
      options
    );

    return {
      context: response.context,
      value: response.value.map((state) =>
        state ? toWeb3JsAccountInfo(state, options.dataSlice) : null
      )
    };
  }

  public override async getMultipleParsedAccounts(
    publicKeys: PublicKey[],
    rawConfig?: GetMultipleAccountsConfig
  ): Promise<RpcResponseAndContext<(AccountInfo<Buffer | ParsedAccountData> | null)[]>> {
    const options = resolveGetMultipleAccountsInfoOptions(
      rawConfig,
      this.accountSyncCommitment
    );
    const response = await this.getBufferedAccountStatesAndContext(
      publicKeys,
      options
    );

    return {
      context: response.context,
      value: await Promise.all(
        response.value.map((state) =>
          state ? this.toParsedAccountInfo(state, options) : null
        )
      )
    };
  }

  // What: Returns locally buffered account info for multiple accounts.
  // Why: web3.js exposes this as the convenience method without context.
  // How: Delegate to the context variant and return only `value`.
  public override async getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    commitmentOrConfig?: Commitment | GetMultipleAccountsConfig
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    const response = await this.getMultipleAccountsInfoAndContext(
      publicKeys,
      commitmentOrConfig
    );
    return response.value;
  }

  // What: Adds accounts to live subscription set.
  // Why: Consumers must be able to enroll additional accounts at runtime.
  // How: Normalize keys then forward to core.
  public async addAccounts(
    accountIds: ReadonlyArray<string | PublicKey>,
    commitment?: Commitment
  ): Promise<void> {
    await this.core.addTrackedAccounts(
      normalizeAccountIds(accountIds),
      resolveGetAccountInfoCommitment(commitment, this.accountSyncCommitment)
    );
  }

  // What: Removes accounts from live subscription set.
  // Why: Consumers must be able to stop buffering accounts at runtime.
  // How: Normalize keys then forward to core.
  public async removeAccounts(
    accountIds: ReadonlyArray<string | PublicKey>,
    commitment?: Commitment
  ): Promise<void> {
    await this.core.removeTrackedAccounts(
      normalizeAccountIds(accountIds),
      resolveGetAccountInfoCommitment(commitment, this.accountSyncCommitment)
    );
  }

  // What: Replaces full live subscription set.
  // Why: Deterministic control API for explicit account list management.
  // How: Normalize keys then forward to core.
  public async setAccounts(
    accountIds: ReadonlyArray<string | PublicKey>,
    commitment?: Commitment
  ): Promise<void> {
    await this.core.setTrackedAccounts(
      normalizeAccountIds(accountIds),
      resolveGetAccountInfoCommitment(commitment, this.accountSyncCommitment)
    );
  }

  // What: Closes underlying stream transport and background tasks.
  // Why: Consumers need explicit lifecycle cleanup.
  // How: Delegate shutdown to core.
  public async close(): Promise<void> {
    await this.core.close();
  }

  // What: Exposes latest background transport error.
  // Why: Allows callers to inspect stream health without custom logging hooks.
  // How: Return last error observed by core transport handler.
  public getLastTransportError(): Error | null {
    return this.core.getLastTransportError();
  }

  private async getBufferedAccountStateAndContext(
    publicKey: PublicKey,
    options: ResolvedGetAccountInfoOptions
  ): Promise<RpcResponseAndContext<BufferedAccountState | null>> {
    const accountId = publicKey.toBase58();
    const observation =
      options.minContextSlot === undefined
        ? await this.core.getBufferedAccountObservation(
            accountId,
            options.commitment
          )
        : await this.core.getBufferedAccountObservation(
            accountId,
            options.commitment,
            { minContextSlot: options.minContextSlot }
          );

    return {
      context: {
        slot: toWeb3JsContextSlot(observationSlot(observation))
      },
      value: observationValue(observation)
    };
  }

  private async getBufferedAccountStatesAndContext(
    publicKeys: PublicKey[],
    options: ResolvedGetAccountInfoOptions
  ): Promise<RpcResponseAndContext<(BufferedAccountState | null)[]>> {
    let minContextSlotOfTheUpdates: number | undefined;
    const accountIds = publicKeys.map((publicKey) => publicKey.toBase58());
    const observations =
      options.minContextSlot === undefined
        ? await this.core.getBufferedAccountObservations(
            accountIds,
            options.commitment
          )
        : await this.core.getBufferedAccountObservations(
            accountIds,
            options.commitment,
            { minContextSlot: options.minContextSlot }
          );
    for (const observation of observations) {
      const slot = toWeb3JsContextSlot(observationSlot(observation));
      minContextSlotOfTheUpdates =
        minContextSlotOfTheUpdates === undefined
          ? slot
          : Math.min(minContextSlotOfTheUpdates, slot);
    }

    return {
      context: {
        slot: minContextSlotOfTheUpdates ?? 0
      },
      value: observations.map(observationValue)
    };
  }

  private async toParsedAccountInfo(
    state: BufferedAccountState,
    options: ResolvedGetAccountInfoOptions
  ): Promise<AccountInfo<Buffer | ParsedAccountData>> {
    const uiAccount = await encodeAccount(
      bufferedAccountToEncodingInput(state),
      "jsonParsed",
      {
        dataSlice: options.dataSlice,
        parseContextFetcher: (contextPubkey) =>
          this.getAccountInfo(contextPubkey, contextFetchConfig(options)),
        cache: this.accountParseContextCache
      }
    );

    return toWeb3JsParsedAccountInfo(uiAccount);
  }
}

function observationSlot(observation: AccountSyncAccountObservation): bigint {
  return observation.kind === "account"
    ? observation.state.slot
    : observation.tombstone.slot;
}

function observationValue(
  observation: AccountSyncAccountObservation
): BufferedAccountState | null {
  return observation.kind === "account" ? observation.state : null;
}

function contextFetchConfig(
  options: ResolvedGetAccountInfoOptions
): GetAccountInfoConfig {
  return {
    commitment: options.commitment,
    minContextSlot: options.minContextSlot
  };
}
