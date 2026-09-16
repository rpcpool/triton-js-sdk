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
import {
  AccountParseContextCache,
  bufferedAccountToEncodingInput
} from "../account_encoding";
import {
  AccountSyncCore,
  type AccountSyncAccountObservation
} from "../core/account_sync_core";
import {
  AccountSyncTransports,
  type AccountSyncCommitment,
  type BufferedAccountState,
  type BrowserCommitmentOrConfig,
  type BrowserAccountSyncConnectionConfig,
  type ResolvedGetAccountInfoOptions
} from "../core/types";
import { RpcInitialStatePlugin } from "../plugins/rpc_initial_state";
import { createConnectionConstructor } from "./connection_selector";
import { parseConnectionAccount } from "./parsed_account";
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

/**
 * A drop-in web3.js connection with locally buffered account reads for browsers.
 *
 * The account information methods overridden by this class read from a live
 * account-sync buffer. Other inherited {@link Web3JsConnection} methods keep
 * using the JSON RPC endpoint as normal. The browser build supports only the
 * WebSocket account-sync transport.
 *
 * The `accountSync` configuration controls the live WebSocket, the accounts
 * kept in the buffer, how reads handle an untracked account, reconnection, RPC
 * polling during stream outages, and shutdown. Accounts in `initialAccounts`
 * stay subscribed until removed. Accounts added by a read are temporary and
 * expire after `dynamicSubscriptionTtlMs` when they are no longer in use, unless
 * `removeAccounts` or `setAccounts` removes them first.
 *
 * When `subscriptionEndpoint` is omitted, its WebSocket URL is derived from
 * `endpoint`. A read at a commitment other than the configured default uses a
 * separate stream and buffer. The browser build does not accept `grpc` options.
 * If WebSocket startup fails, the error is available from
 * {@link getLastTransportError} while RPC polling and reconnect attempts continue.
 *
 * Call {@link close} when the connection is no longer needed so its stream and
 * background work can stop.
 *
 * @example Configure every browser account-sync option
 * ```ts
 * import { AccountSyncTransports, Connection, PublicKey } from "@triton-one/triton-sdk";
 *
 * const address = new PublicKey("11111111111111111111111111111111");
 * const connection = new Connection("https://example.com/token", {
 *   accountSync: {
 *     // WebSocket is the only browser transport and is the default.
 *     transport: AccountSyncTransports.WS,
 *
 *     // Optional WebSocket endpoint override. By default it is derived from
 *     // the Connection endpoint.
 *     subscriptionEndpoint: "wss://account-sync.example.com/token",
 *
 *     // Default commitment for buffered reads. Defaults to "confirmed".
 *     commitment: "confirmed",
 *
 *     // Accounts pinned in the subscription from startup. Defaults to [].
 *     initialAccounts: [address],
 *
 *     // Subscribe temporarily when a read misses the buffer. Defaults to true.
 *     autoSubscribeOnMiss: true,
 *
 *     // Maximum wait for a buffered account observation. Defaults to 5 seconds.
 *     missTimeoutMs: 5_000,
 *
 *     // RPC refresh interval while the live stream is unavailable. Defaults to 1 second.
 *     rpcPollIntervalMs: 1_000,
 *
 *     // Reconnect delay starts at 100 ms and grows up to 5 seconds by default.
 *     reconnectInitialDelayMs: 100,
 *     reconnectMaxDelayMs: 5_000,
 *
 *     // Maximum time for one WebSocket connection attempt. Defaults to 10 seconds.
 *     connectTimeoutMs: 10_000,
 *
 *     // Maximum time to stop account-sync background work. Defaults to 5 seconds.
 *     closeTimeoutMs: 5_000,
 *
 *     // Idle lifetime of temporary subscriptions created by reads. Defaults to 60 seconds.
 *     dynamicSubscriptionTtlMs: 60_000
 *   }
 * });
 *
 * const account = await connection.getAccountInfo(address);
 * await connection.close();
 * ```
 */
export class AccountSyncConnection extends Web3JsConnection {
  private readonly core: AccountSyncCore;
  private readonly accountSyncCommitment: AccountSyncCommitment;
  private readonly accountParseContextCache = new AccountParseContextCache();

  /**
   * Creates a web3.js-compatible connection and starts its account-sync buffer.
   *
   * @param endpoint Fullnode JSON RPC endpoint. It is also used to derive the
   * account-sync WebSocket endpoint unless `accountSync.subscriptionEndpoint` is set.
   * @param commitmentOrConfig Default commitment or a web3.js connection
   * configuration extended with browser account-sync options.
   * @throws `Error` when an endpoint or account-sync option is invalid, an
   * initial account address is invalid, or gRPC is requested.
   */
  constructor(endpoint: string, commitmentOrConfig?: BrowserCommitmentOrConfig) {
    const { commitment, config } =
      splitCommitmentAndConfig<BrowserAccountSyncConnectionConfig>(
        commitmentOrConfig
      );
    super(endpoint, buildWeb3JsConnectionCtorArg(commitment, config));

    const accountSyncOptions = config.accountSync;
    if (
      accountSyncOptions?.transport &&
      accountSyncOptions.transport !== AccountSyncTransports.WS
    ) {
      throw new Error("browser build supports only websocket transport");
    }
    if ((accountSyncOptions as { grpc?: unknown } | undefined)?.grpc) {
      throw new Error("browser build does not support accountSync.grpc options");
    }

    const fallbackWsEndpoint = deriveWebSocketEndpoint(endpoint);
    const resolved = resolveAccountSyncSettings(
      accountSyncOptions,
      fallbackWsEndpoint,
      AccountSyncTransports.WS,
      commitment
    );
    this.accountSyncCommitment = resolved.commitment;

    this.core = new AccountSyncCore({
      transportFactory: () =>
        new WsAccountSubscriptionTransport(
          resolved.subscriptionEndpoint,
          createBrowserWebSocket,
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
      onAccountsInvalidated: (accountIds) => {
        for (const accountId of accountIds) {
          this.accountParseContextCache.delete(accountId);
        }
      }
    });
  }

  /**
   * Reads one account and the slot associated with its local observation.
   *
   * A cache miss can create a temporary subscription and hydrate the account
   * from RPC. A requested `minContextSlot` must be satisfied before the read
   * completes. `dataSlice` changes only the returned data; the runtime `space`
   * field still describes the full account data length.
   *
   * @param publicKey Address of the account to read.
   * @param commitmentOrConfig Commitment or web3.js account read options.
   * @returns The account and observation context, or `null` when RPC confirms
   * that the account does not exist.
   * @throws {@link AccountSyncReadTimeoutError} when the local buffer cannot
   * satisfy the read before `missTimeoutMs`.
   */
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

  /**
   * Reads one account from the local account-sync buffer.
   *
   * This is the value-only form of {@link getAccountInfoAndContext}. Errors are
   * wrapped with the account address to match web3.js behavior.
   *
   * @param publicKey Address of the account to read.
   * @param commitmentOrConfig Commitment or web3.js account read options.
   * @returns Account information, or `null` when the account does not exist.
   * @throws `Error` when the buffered read, hydration, or input validation fails.
   */
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

  /**
   * Reads and parses one account from the local account-sync buffer.
   *
   * The parser may read supporting accounts, such as an SPL token mint, through
   * this connection. Parse failures and unavailable context reject the read.
   *
   * @param publicKey Address of the account to read.
   * @param commitmentOrConfig Commitment or web3.js account read options.
   * @returns Parsed account information and its observation context, or `null`
   * when the account does not exist.
   * @throws {@link AccountSyncReadTimeoutError} when a required buffered read
   * cannot be satisfied before `missTimeoutMs`.
   */
  public override async getParsedAccountInfo(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig
  ): Promise<RpcResponseAndContext<AccountInfo<ParsedAccountData> | null>> {
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

  /**
   * Reads several accounts and a shared context from the local buffer.
   *
   * Results preserve input order and duplicate keys. The context slot is the
   * lowest observation slot in the result, including observations that an
   * account is missing.
   *
   * @param publicKeys Addresses of the accounts to read.
   * @param commitmentOrConfig Commitment or web3.js multiple-account options.
   * @returns Account values and their shared context.
   * @throws {@link AccountSyncReadTimeoutError} when any account cannot satisfy
   * the read before `missTimeoutMs`.
   */
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

  /**
   * Reads and parses several accounts from the local account-sync buffer.
   *
   * Results preserve input order and duplicate keys. A parse or context fetch
   * failure rejects the entire read. Missing accounts return `null`.
   *
   * @param publicKeys Addresses of the accounts to read.
   * @param rawConfig web3.js multiple-account read options.
   * @returns Parsed account values and the lowest observation slot shared by the result.
   * @throws {@link AccountSyncReadTimeoutError} when any required account read times out.
   */
  public override async getMultipleParsedAccounts(
    publicKeys: PublicKey[],
    rawConfig?: GetMultipleAccountsConfig
  ): Promise<RpcResponseAndContext<(AccountInfo<ParsedAccountData> | null)[]>> {
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

  /**
   * Reads several accounts from the local account-sync buffer.
   *
   * Results preserve input order and duplicate keys. This is the value-only
   * form of {@link getMultipleAccountsInfoAndContext}.
   *
   * @param publicKeys Addresses of the accounts to read.
   * @param commitmentOrConfig Commitment or web3.js multiple-account options.
   * @returns Account information in input order, with `null` for missing accounts.
   * @throws {@link AccountSyncReadTimeoutError} when any account read times out.
   */
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

  /**
   * Pins accounts in the live subscription set without removing existing ones.
   *
   * @param accountIds Account addresses to add. Duplicate addresses are ignored.
   * @param commitment Commitment-specific subscription set to update. Defaults
   * to the account-sync commitment configured on this connection.
   * @returns A promise that settles after the desired account set is recorded
   * and any current stream update attempt finishes. If the stream is unavailable
   * or the attempt fails, polling and reconnection use the new set.
   * @throws `Error` when an address is invalid or the connection is closed.
   *
   * @example
   * ```ts
   * await connection.addAccounts([accountA, accountB], "finalized");
   * ```
   */
  public async addAccounts(
    accountIds: ReadonlyArray<string | PublicKey>,
    commitment?: Commitment
  ): Promise<void> {
    await this.core.addTrackedAccounts(
      normalizeAccountIds(accountIds),
      resolveGetAccountInfoCommitment(commitment, this.accountSyncCommitment)
    );
  }

  /**
   * Unpins accounts from a commitment's live subscription set.
   *
   * Removing an account immediately removes its pinned or temporary ownership
   * and invalidates its cached state. An active read can continue through its
   * one-time RPC request. After {@link close}, removing from a commitment that
   * has no lane remains a successful no-op; other removals reject.
   *
   * @param accountIds Account addresses to remove. Untracked addresses do not
   * change the subscription, but their parse-context cache entries are invalidated.
   * @param commitment Commitment-specific subscription set to update. Defaults
   * to the account-sync commitment configured on this connection.
   * @returns A promise that settles after the desired account set is recorded
   * and any current stream update attempt finishes. If the stream is unavailable
   * or the attempt fails, polling and reconnection use the new set.
   * @throws `Error` when an address is invalid, or when the connection is closed
   * and the commitment lane exists.
   */
  public async removeAccounts(
    accountIds: ReadonlyArray<string | PublicKey>,
    commitment?: Commitment
  ): Promise<void> {
    await this.core.removeTrackedAccounts(
      normalizeAccountIds(accountIds),
      resolveGetAccountInfoCommitment(commitment, this.accountSyncCommitment)
    );
  }

  /**
   * Replaces all pinned accounts for one commitment.
   *
   * Accounts outside the new set immediately lose pinned and temporary ownership,
   * and all temporary leases for this commitment are cleared. Active reads for
   * removed accounts can continue through their one-time RPC requests.
   *
   * @param accountIds Complete set of account addresses to pin. Duplicates are ignored.
   * @param commitment Commitment-specific subscription set to replace. Defaults
   * to the account-sync commitment configured on this connection.
   * @returns A promise that settles after the desired account set is recorded
   * and any current stream update attempt finishes. If the stream is unavailable
   * or the attempt fails, polling and reconnection use the new set.
   * @throws `Error` when an address is invalid or the connection is closed.
   */
  public async setAccounts(
    accountIds: ReadonlyArray<string | PublicKey>,
    commitment?: Commitment
  ): Promise<void> {
    await this.core.setTrackedAccounts(
      normalizeAccountIds(accountIds),
      resolveGetAccountInfoCommitment(commitment, this.accountSyncCommitment)
    );
  }

  /**
   * Stops account-sync streams, timers, retries, and pending buffered reads.
   *
   * Calling `close` more than once returns the same shutdown operation. Inherited
   * web3.js JSON RPC methods are not managed by this account-sync lifecycle.
   *
   * @returns A promise that settles when account-sync shutdown is complete.
   * @throws `Error` when shutdown exceeds `closeTimeoutMs`.
   */
  public async close(): Promise<void> {
    await this.core.close();
  }

  /**
   * Returns the latest background account-sync error.
   *
   * This can be a transport, RPC polling, hydration, or reconciliation error.
   * The SDK can recover after it, so a non-null result does not by itself mean
   * that reads are unavailable. The error is retained and is not cleared after
   * recovery.
   *
   * @returns The latest background error, or `null` if none has been observed.
   */
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
  ): Promise<AccountInfo<ParsedAccountData>> {
    return parseConnectionAccount(
      bufferedAccountToEncodingInput(state),
      (contextPubkey) => this.getAccountInfo(contextPubkey, contextFetchConfig(options)),
      this.accountParseContextCache
    );
  }
}

function createBrowserWebSocket(endpoint: string): WebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this runtime");
  }

  return new WebSocket(endpoint) as unknown as WebSocketLike;
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

/** A native web3.js connection unless accountSync options are supplied. */
export const Connection = createConnectionConstructor<
  BrowserAccountSyncConnectionConfig,
  AccountSyncConnection
>(AccountSyncConnection);

export type Connection = Web3JsConnection;
