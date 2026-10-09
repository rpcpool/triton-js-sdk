import {
  Connection as Web3JsConnection,
  type AccountInfo,
  type Commitment,
  type ConnectionConfig,
  type DataSlice,
  type GetAccountInfoConfig,
  type GetMultipleAccountsConfig,
  type ParsedAccountData,
  type PublicKey,
  type RpcResponseAndContext
} from "@solana/web3.js";

export * from "@solana/web3.js";

/**
 * Create a Solana connection with optional account-sync reads.
 *
 * Supplying accountSync selects AccountSyncConnection. Omitting it uses the
 * native web3.js Connection with the supplied commitment and connection options.
 *
 * @param endpoint URL of the Solana JSON RPC endpoint.
 * @param config Optional default commitment or connection options.
 * @returns The connection selected by the accountSync settings.
 * @throws Error when the endpoint or connection settings are invalid.
 */
export declare const Connection: {
  /**
   * Create a connection with account-sync reads enabled.
   *
   * @param endpoint URL of the Solana JSON RPC endpoint.
   * @param config Connection options with account-sync settings.
   * @returns A connection that serves account reads through account-sync.
   * @throws Error when the endpoint or account-sync settings are invalid.
   */
  new (
    endpoint: string,
    config: BrowserAccountSyncConnectionConfig & {
      accountSync: NonNullable<BrowserAccountSyncConnectionConfig["accountSync"]>;
    }
  ): AccountSyncConnection;
  /**
   * Create a connection using the supplied commitment or options.
   *
   * @param endpoint URL of the Solana JSON RPC endpoint.
   * @param config Optional default commitment or connection options.
   * @returns An account-sync connection when accountSync is supplied, or a native web3.js connection otherwise.
   * @throws Error when the endpoint or connection settings are invalid.
   */
  new (endpoint: string, config?: Commitment | BrowserAccountSyncConnectionConfig): Web3JsConnection;
};

export type Connection = Web3JsConnection;

/** Subscription transports supported by the SDK. */
export declare enum AccountSyncTransports {
  /** Yellowstone account-sync over WebSocket. */
  WS = "ws",
  /** Yellowstone account-sync over gRPC. Available only in Node.js. */
  GRPC = "grpc"
}

/** Subscription transports available in the browser build. */
export type BrowserSubscriptionTransport = AccountSyncTransports.WS;
/** A commitment level supported by the account-sync buffer. */
export type AccountSyncCommitment = "processed" | "confirmed" | "finalized";

/** Details attached to an {@link AccountSyncReadTimeoutError}. */
export interface AccountSyncReadTimeoutErrorOptions {
  /** Base58 address of the account being read. */
  accountId: string;
  /** Commitment buffer used for the read. */
  commitment: AccountSyncCommitment;
  /** Time the read waited, in milliseconds. */
  timeoutMs: number;
  /** Minimum context slot requested by the caller, when set. */
  minContextSlot?: number;
}

/**
 * Thrown when the local buffer cannot satisfy an account read before its time limit.
 */
export declare class AccountSyncReadTimeoutError extends Error {
  /** Base58 address of the account being read. */
  readonly accountId: string;
  /** Commitment buffer used for the read. */
  readonly commitment: AccountSyncCommitment;
  /** Time the read waited, in milliseconds. */
  readonly timeoutMs: number;
  /** Minimum context slot requested by the caller, when set. */
  readonly minContextSlot?: number;
  /** @param options Account address, commitment, and read constraints. */
  constructor(options: AccountSyncReadTimeoutErrorOptions);
}

/**
 * Configures the local account-sync buffer used by {@link Connection} account reads.
 *
 * All time values are in milliseconds and must be positive safe integers.
 */
export interface AccountSyncOptions<TTransport extends AccountSyncTransports> {
  /** Subscription transport. The browser build accepts only WebSocket. */
  transport?: TTransport;
  /** Account-sync WebSocket endpoint override. Defaults to one derived from the RPC endpoint. */
  subscriptionEndpoint?: string;
  /** Default commitment for account-sync reads. Defaults to `"confirmed"`. */
  commitment?: AccountSyncCommitment;
  /** Accounts to subscribe to as soon as the connection starts. Defaults to none. */
  initialAccounts?: ReadonlyArray<string | PublicKey>;
  /** Whether a read should temporarily subscribe to an untracked account. Defaults to `true`. */
  autoSubscribeOnMiss?: boolean;
  /** Maximum time a buffered read waits for an account observation. Defaults to 5 seconds. */
  missTimeoutMs?: number;
  /** Interval between RPC refreshes while a stream is unavailable. Defaults to 1 second. */
  rpcPollIntervalMs?: number;
  /** Initial delay before reconnecting a failed stream. Defaults to 100 milliseconds. */
  reconnectInitialDelayMs?: number;
  /** Maximum reconnect delay. Defaults to 5 seconds. */
  reconnectMaxDelayMs?: number;
  /** Maximum time for one WebSocket connection attempt. Defaults to 10 seconds. */
  connectTimeoutMs?: number;
  /** Maximum time to wait for shutdown. Defaults to 5 seconds. */
  closeTimeoutMs?: number;
  /** Idle lifetime of subscriptions created by reads. Defaults to 60 seconds. */
  dynamicSubscriptionTtlMs?: number;
}

/** web3.js connection configuration extended with browser account-sync options. */
export interface BrowserAccountSyncConnectionConfig extends ConnectionConfig {
  /** Local account-sync buffer and WebSocket subscription settings. */
  accountSync?: AccountSyncOptions<BrowserSubscriptionTransport>;
}

/**
 * Account data encodings accepted by the encoding helpers.
 *
 * `"binary"` is the legacy name for base58. `"base64+zstd"` is compressed data.
 */
export type AccountDataEncoding =
  | "binary"
  | "base58"
  | "base64"
  | "base64+zstd"
  | "jsonParsed";

/**
 * Account data shape returned in a {@link UiAccount}.
 *
 * Legacy `"binary"` output is a string, other raw encodings use a tuple, and
 * parsed output uses the web3.js {@link ParsedAccountData} shape.
 */
export type EncodedAccountData =
  | string
  | [string, Exclude<AccountDataEncoding, "jsonParsed">]
  | ParsedAccountData;

/** JSON-compatible account information in Solana RPC response form. */
export interface UiAccount<T = EncodedAccountData> {
  /** Account balance in lamports. */
  lamports: number;
  /** Account data encoded in the requested form. */
  data: T;
  /** Base58 address of the program that owns the account. */
  owner: string;
  /** Whether the account contains an executable program. */
  executable: boolean;
  /** Epoch at which the account will next owe rent. */
  rentEpoch: number;
  /** Full account data size in bytes, even when `dataSlice` is used. */
  space?: number;
}

/** Raw account values accepted by {@link encodeAccount}. */
export interface AccountEncodingInput {
  /** Address of the account being encoded. */
  pubkey: string | PublicKey;
  /** Address of the program that owns the account. */
  owner: string | PublicKey;
  /** Account balance as an unsigned 64-bit integer. */
  lamports: number | bigint | string;
  /** Whether the account contains an executable program. */
  executable: boolean;
  /** Rent epoch as an unsigned 64-bit integer. */
  rentEpoch: number | bigint | string;
  /** Raw account bytes, or a base64-encoded string. */
  data: Uint8Array | Buffer | string;
}

/** Latest decoded account update together with its local arrival time. */
export interface BufferedAccountState {
  /** Base58 account address. */
  accountId: string;
  /** Account balance in lamports. */
  lamports: bigint;
  /** Base58 address of the program that owns the account. */
  owner: string;
  /** Whether the account contains an executable program. */
  executable: boolean;
  /** Epoch at which the account will next owe rent. */
  rentEpoch: bigint;
  /** Raw account data. */
  data: Uint8Array;
  /** Slot that produced this update. */
  slot: bigint;
  /** Write sequence within the slot. */
  writeVersion: bigint;
  /** Unix time in milliseconds when the buffer accepted the update. */
  updatedAtMs: number;
}

/** SPL token mint data supplied while parsing a token account. */
export interface AccountParseContextMint {
  /** Address of the mint account. */
  pubkey: string | PublicKey;
  /** Raw mint account bytes, or a base64-encoded string. */
  data: Uint8Array | Buffer | string;
}

/** Extra on-chain or clock data that some account parsers require. */
export interface AccountParseContext {
  /** Mint account used to calculate display amounts for an SPL token account. */
  splTokenMint?: AccountParseContextMint;
  /** Unix time in seconds used by parsers whose output depends on the current time. */
  unixTimestamp?: number;
}

/** Minimal account value accepted from an {@link AccountParseContextFetcher}. */
export interface AccountParseContextAccount {
  /** Raw account bytes, or a base64-encoded string. */
  data: Uint8Array | Buffer | string;
}

/**
 * Loads an account needed to parse another account.
 *
 * @param pubkey Address of the context account to load.
 * @returns Account data, or `null` when the account does not exist.
 */
export type AccountParseContextFetcher = (
  pubkey: PublicKey
) => Promise<AccountInfo<Buffer> | AccountParseContextAccount | null>;

/** Options for {@link encodeAccount}. */
export interface AccountEncodingOptions {
  /** Byte range to return for raw encodings. `space` still reports the full data size. */
  dataSlice?: DataSlice;
  /** Parser inputs already available to the caller. */
  parseContext?: AccountParseContext;
  /** Unix time in seconds. Overrides `parseContext.unixTimestamp`. */
  unixTimestamp?: number;
}

/** Reserved options for {@link convertAccountData}. */
export interface ConvertAccountDataOptions {}

/** Options for {@link AccountParseContextCache}. */
export interface AccountParseContextCacheOptions {
  /** Maximum cached accounts. Least-recently-used entries are removed first. Defaults to 256. */
  maxEntries?: number;
  /** Time a cached account or missing-account result remains valid. Defaults to 5 minutes. */
  ttlMs?: number;
}

/** Thrown when an encoding or account parser is not supported. */
export declare class UnsupportedEncodingError extends Error {
  /** Base58 address of the account being encoded, when available. */
  readonly pubkey?: string;
  /** Base58 address of the owning program, when available. */
  readonly owner?: string;
  /** Requested output encoding, when available. */
  readonly encoding?: AccountDataEncoding;
}

/** Thrown when account fields or encoded data cannot be validated or decoded. */
export declare class InvalidAccountDataError extends Error {
  /** Base58 address of the account being encoded, when available. */
  readonly pubkey?: string;
  /** Base58 address of the owning program, when available. */
  readonly owner?: string;
  /** Requested output encoding, when available. */
  readonly encoding?: AccountDataEncoding;
}

/** Thrown when parsed output needs account data that could not be supplied or loaded. */
export declare class MissingParseContextError extends Error {
  /** Base58 address of the account being parsed, when available. */
  readonly pubkey?: string;
  /** Base58 address of the owning program, when available. */
  readonly owner?: string;
  /** Requested output encoding, when available. */
  readonly encoding?: AccountDataEncoding;
  /** Addresses of the accounts required to continue parsing. */
  readonly missingAccounts: readonly string[];
  /** Parser-specific name for the missing context. */
  readonly contextKind?: string;
}

/** Thrown when an {@link AccountParseContextFetcher} fails. */
export declare class ContextFetchError extends Error {
  /** Base58 address of the account being parsed, when available. */
  readonly pubkey?: string;
  /** Base58 address of the owning program, when available. */
  readonly owner?: string;
  /** Requested output encoding, when available. */
  readonly encoding?: AccountDataEncoding;
  /** Address that the context fetcher was asked to load. */
  readonly missingAccount?: string;
  /** Parser-specific name for the requested context. */
  readonly contextKind?: string;
}

/** Thrown when the account encoding WASM module fails unexpectedly. */
export declare class WasmParserError extends Error {
  /** Base58 address of the account being encoded, when available. */
  readonly pubkey?: string;
  /** Base58 address of the owning program, when available. */
  readonly owner?: string;
  /** Requested output encoding, when available. */
  readonly encoding?: AccountDataEncoding;
}

/**
 * A bounded cache for accounts loaded to support parsed account output.
 *
 * It caches missing accounts and shares concurrent loads for the same address.
 */
export declare class AccountParseContextCache {
  /**
   * Create a cache for accounts used during parsing.
   *
   * @param options Capacity and expiry settings.
   * @throws `Error` if an option is not a positive safe integer.
   */
  constructor(options?: AccountParseContextCacheOptions);
  /**
   * Read a cached entry and mark it as recently used without extending its expiry.
   *
   * @param pubkey Address of the context account.
   * @returns A cached account, `null` for a cached miss, or `undefined` when absent or expired.
   */
  get(pubkey: string | PublicKey): AccountParseContextAccount | null | undefined;
  /**
   * Store an account or a known missing-account result until the cache entry expires.
   *
   * @param pubkey Address of the context account.
   * @param value Account data, or `null` when the account does not exist.
   */
  set(pubkey: string | PublicKey, value: AccountParseContextAccount | null): void;
  /**
   * Returns a cached value or calls and shares `loader`. Loader failures are not cached.
   *
   * @param pubkey Address of the context account.
   * @param loader Function used to load an uncached account.
   * @returns The loaded account, or `null` when it does not exist.
   * @throws Error when the loader rejects. The failure is passed to the caller.
   */
  getOrLoad(
    pubkey: string | PublicKey,
    loader: () => Promise<AccountParseContextAccount | null>
  ): Promise<AccountParseContextAccount | null>;
  /**
   * Remove all cached values and prevent pending loads from storing their results.
   *
   * Pending loads continue and still settle for their existing callers.
   * @returns Nothing.
   */
  clear(): void;
}

/**
 * Loads the shared account encoding WASM module.
 *
 * @returns The initialized module. Initialization is lazy and shared by callers.
 * @throws `Error` when the WASM file cannot be loaded or initialized.
 */
export declare function loadAccountEncodingWasm(): Promise<unknown>;
/** @returns Whether this build supports `"base64+zstd"`. */
export declare function isBase64ZstdEncodingSupported(): boolean;
/**
 * Encode an account as parsed JSON, with base64 bytes as the fallback.
 *
 * Supply mint and time data through options when the account's parser needs it.
 * Parsed JSON is not sliced. Raw fallback applies dataSlice except for SPL Token
 * accounts, whose JSON encoding follows RPC's unsliced token path.
 *
 * @param input Account address, owner, balance, rent epoch, executable flag, and raw data.
 * @param encoding The jsonParsed encoding.
 * @param options Optional data slice and token mint or time information.
 * @returns An RPC account containing parsed JSON or a base64 data tuple when parsing is unavailable.
 * @throws InvalidAccountDataError when account values, context, or slice options are invalid.
 * @throws WasmParserError when the WASM encoder fails or returns invalid JSON.
 * @throws Error when the WASM module cannot be loaded or initialized.
 */
export declare function encodeAccount(
  input: AccountEncodingInput,
  encoding: "jsonParsed",
  options?: AccountEncodingOptions
): Promise<UiAccount<ParsedAccountData | [string, "base64"]>>;
/**
 * Encode raw account values in Solana RPC account form.
 *
 * @param input Account address, owner, balance, rent epoch, executable flag, and raw data.
 * @param encoding Requested account data encoding.
 * @param options Optional data slice and token mint or time information.
 * @returns An RPC account in the requested encoding, with base64 fallback when JSON parsing is unavailable.
 * @throws UnsupportedEncodingError when the requested encoding is not supported.
 * @throws InvalidAccountDataError when account values, context, or slice options are invalid.
 * @throws WasmParserError when the WASM encoder fails or returns invalid JSON.
 * @throws Error when the WASM module cannot be loaded or initialized.
 */
export declare function encodeAccount(
  input: AccountEncodingInput,
  encoding: AccountDataEncoding,
  options?: AccountEncodingOptions
): Promise<UiAccount>;
/**
 * Converts raw account data between binary encodings.
 *
 * Parsed JSON is not a raw byte encoding and cannot be converted.
 *
 * @param input Account data encoded using `from`.
 * @param from Current encoding of `input`.
 * @param to Encoding to produce.
 * @param options Reserved conversion options.
 * @returns The same account bytes encoded using `to`.
 * @throws {@link UnsupportedEncodingError} when either encoding is `"jsonParsed"`.
 * @throws {@link InvalidAccountDataError} when `input` is invalid for `from`.
 * @throws WasmParserError when the WASM encoder fails.
 * @throws Error when the WASM module cannot be loaded or initialized.
 *
 * @example
 * ```ts
 * const base58Data = await convertAccountData(base64Data, "base64", "base58");
 * ```
 */
export declare function convertAccountData(
  input: string,
  from: AccountDataEncoding,
  to: AccountDataEncoding,
  options?: ConvertAccountDataOptions
): Promise<string>;
/**
 * Converts web3.js account information into input accepted by {@link encodeAccount}.
 *
 * @param pubkey Address associated with `accountInfo`.
 * @param accountInfo Raw web3.js account information.
 * @returns Account values in encoder input form.
 */
export declare function accountInfoToEncodingInput(
  pubkey: string | PublicKey,
  accountInfo: AccountInfo<Buffer>
): AccountEncodingInput;
/**
 * Converts buffered account state into input accepted by {@link encodeAccount}.
 *
 * @param state Account state from the local account-sync buffer.
 * @returns Account values without buffer bookkeeping fields.
 */
export declare function bufferedAccountToEncodingInput(
  state: BufferedAccountState
): AccountEncodingInput;
/**
 * Convert an encoded account into the web3.js parsed-account response shape.
 *
 * Preserves the account fields, converts the owner to PublicKey, and converts
 * base64 data to Buffer. Parsed JSON data is returned as an object.
 *
 * @param account RPC account returned by encodeAccount with jsonParsed encoding.
 * @returns Account information containing a Buffer or ParsedAccountData.
 * @throws UnsupportedEncodingError when data is neither parsed JSON nor a base64 tuple.
 * @throws Error when the owner is not a valid public key.
 */
export declare function toWeb3JsParsedAccountInfo(
  account: UiAccount
): AccountInfo<Buffer | ParsedAccountData>;

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
export declare class AccountSyncConnection extends Web3JsConnection {
  /**
   * Creates a connection and starts its WebSocket account-sync buffer.
   *
   * @param endpoint Fullnode JSON RPC endpoint and source for account-sync defaults.
   * @param commitmentOrConfig Default commitment or extended web3.js connection options.
   * @throws `Error` when an endpoint, address, or option is invalid, or gRPC is requested.
   */
  constructor(
    endpoint: string,
    commitmentOrConfig?: Commitment | BrowserAccountSyncConnectionConfig
  );

  /**
   * Reads one account from the local account-sync buffer.
   *
   * @param publicKey Address of the account to read.
   * @param commitmentOrConfig Commitment or web3.js account read options.
   * @returns Account information, or `null` when the account does not exist.
   * @throws `Error` when the buffered read, hydration, or input validation fails.
   */
  getAccountInfo(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig
  ): Promise<AccountInfo<Buffer> | null>;

  /**
   * Reads one account and the slot associated with its local observation.
   *
   * A cache miss can create a temporary subscription. `minContextSlot` must be
   * satisfied before the read completes. `dataSlice` does not change `space`.
   *
   * @param publicKey Address of the account to read.
   * @param commitmentOrConfig Commitment or web3.js account read options.
   * @returns The account and observation context, or `null` for a missing account.
   * @throws {@link AccountSyncReadTimeoutError} when the read reaches its time limit.
   */
  getAccountInfoAndContext(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>>;

  /**
   * Fetch parsed account info for the specified public key.
   *
   * Reads from the account-sync buffer. Data is parsed JSON when supported and a
   * Buffer otherwise. Token parsing can read the mint and Clock accounts.
   *
   * @param publicKey Public key of the account to fetch.
   * @param commitmentOrConfig Optional commitment or account read options, including minContextSlot and dataSlice.
   * @returns The account and its observation context, with value set to null when the account does not exist.
   * @throws AccountSyncReadTimeoutError when a required buffered read times out.
   * @throws Error when options are invalid, the connection is closed, a required fetch fails, or WASM cannot run.
   */
  getParsedAccountInfo(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer | ParsedAccountData> | null>>;

  /**
   * Fetch parsed account info for the specified public keys.
   *
   * Preserves input order and duplicate keys. Each value contains parsed JSON,
   * raw bytes as a Buffer, or null for a missing account. The context slot is the
   * lowest observation slot across the requested accounts.
   *
   * @param publicKeys Public keys of the accounts to fetch.
   * @param rawConfig Optional commitment, minimum context slot, and data slice.
   * @returns Account values and their shared observation context.
   * @throws AccountSyncReadTimeoutError when any required buffered read times out.
   * @throws Error when options are invalid, the connection is closed, a required fetch fails, or WASM cannot run.
   */
  getMultipleParsedAccounts(
    publicKeys: PublicKey[],
    rawConfig?: GetMultipleAccountsConfig
  ): Promise<RpcResponseAndContext<(AccountInfo<Buffer | ParsedAccountData> | null)[]>>;

  /**
   * Reads several accounts and a shared context from the local buffer.
   *
   * Results preserve input order and duplicates. The context uses the lowest
   * account or missing-account observation slot.
   *
   * @param publicKeys Addresses of the accounts to read.
   * @param commitmentOrConfig Commitment or web3.js multiple-account options.
   * @returns Account values and their shared context.
   * @throws {@link AccountSyncReadTimeoutError} when any read times out.
   */
  getMultipleAccountsInfoAndContext(
    publicKeys: PublicKey[],
    commitmentOrConfig?: Commitment | GetMultipleAccountsConfig
  ): Promise<RpcResponseAndContext<(AccountInfo<Buffer> | null)[]>>;

  /**
   * Reads several accounts from the local buffer and returns values in input order.
   *
   * @param publicKeys Addresses of the accounts to read.
   * @param commitmentOrConfig Commitment or web3.js multiple-account options.
   * @returns Account information with `null` entries for missing accounts.
   * @throws {@link AccountSyncReadTimeoutError} when any read times out.
   */
  getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    commitmentOrConfig?: Commitment | GetMultipleAccountsConfig
  ): Promise<(AccountInfo<Buffer> | null)[]>;

  /**
   * Pins accounts without removing existing pinned accounts.
   *
   * @param accountIds Addresses to add. Duplicates are ignored.
   * @param commitment Subscription set to update. Defaults to the account-sync commitment.
   * @returns A promise that settles after the desired set is recorded and any
   * current stream update attempt finishes. Polling and reconnection use the new
   * set if the stream is unavailable or the attempt fails.
   * @throws `Error` when an address is invalid or the connection is closed.
   */
  addAccounts(accountIds: ReadonlyArray<string | PublicKey>, commitment?: Commitment): Promise<void>;
  /**
   * Unpins accounts and immediately invalidates their cached state. Active reads
   * can continue through their one-time RPC requests. After {@link close}, a
   * missing commitment lane remains a successful no-op; other removals reject.
   *
   * @param accountIds Addresses to remove. Untracked addresses still have their
   * parse-context cache entries invalidated.
   * @param commitment Subscription set to update. Defaults to the account-sync commitment.
   * @returns A promise that settles after the desired set is recorded and any
   * current stream update attempt finishes. Polling and reconnection use the new
   * set if the stream is unavailable or the attempt fails.
   * @throws `Error` when an address is invalid, or when the connection is closed
   * and the commitment lane exists.
   */
  removeAccounts(accountIds: ReadonlyArray<string | PublicKey>, commitment?: Commitment): Promise<void>;
  /**
   * Replaces all pinned accounts and clears all temporary leases for a commitment.
   * Accounts outside the new set immediately lose ownership and cached state.
   *
   * @param accountIds Complete pinned set. Duplicates are ignored.
   * @param commitment Subscription set to replace. Defaults to the account-sync commitment.
   * @returns A promise that settles after the desired set is recorded and any
   * current stream update attempt finishes. Polling and reconnection use the new
   * set if the stream is unavailable or the attempt fails.
   * @throws `Error` when an address is invalid or the connection is closed.
   */
  setAccounts(accountIds: ReadonlyArray<string | PublicKey>, commitment?: Commitment): Promise<void>;
  /**
   * Stops account-sync streams, timers, retries, and pending buffered reads.
   *
   * Repeated calls return the same shutdown operation.
   * @returns A promise that settles when account-sync shutdown is complete.
   * @throws `Error` when shutdown exceeds `closeTimeoutMs`.
   */
  close(): Promise<void>;
  /**
   * Returns the latest background account-sync error, or `null` if none occurred.
   *
   * This includes transport, RPC polling, hydration, and reconciliation errors.
   * The error remains available after recovery and does not alone mean reads are unavailable.
   * @returns The latest background error, or `null` if none has been observed.
   */
  getLastTransportError(): Error | null;
}
