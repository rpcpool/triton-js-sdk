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

export declare enum AccountSyncTransports {
  WS = "ws",
  GRPC = "grpc"
}

export type NodeSubscriptionTransport =
  | AccountSyncTransports.WS
  | AccountSyncTransports.GRPC;
export type AccountSyncCommitment = "processed" | "confirmed" | "finalized";

export interface AccountSyncReadTimeoutErrorOptions {
  accountId: string;
  commitment: AccountSyncCommitment;
  timeoutMs: number;
  minContextSlot?: number;
}

export declare class AccountSyncReadTimeoutError extends Error {
  readonly accountId: string;
  readonly commitment: AccountSyncCommitment;
  readonly timeoutMs: number;
  readonly minContextSlot?: number;
  constructor(options: AccountSyncReadTimeoutErrorOptions);
}

export declare class AccountSyncAccountLimitError extends Error {
  readonly commitment: AccountSyncCommitment;
  readonly limit: number;
  constructor(commitment: AccountSyncCommitment, limit: number);
}

export interface GrpcTransportOptions {
  flowControlWindowBytes?: number;
  maxReceiveMessageLengthBytes?: number;
  keepAliveIntervalMs?: number;
  keepAliveTimeoutMs?: number;
  keepAlivePermitWithoutCalls?: boolean;
}

export interface AccountSyncOptions<TTransport extends AccountSyncTransports> {
  transport?: TTransport;
  subscriptionEndpoint?: string;
  commitment?: AccountSyncCommitment;
  initialAccounts?: ReadonlyArray<string | PublicKey>;
  autoSubscribeOnMiss?: boolean;
  missTimeoutMs?: number;
  rpcPollIntervalMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
  dynamicSubscriptionTtlMs?: number;
  maxAccountsPerCommitment?: number;
  grpc?: TTransport extends AccountSyncTransports.GRPC
    ? GrpcTransportOptions
    : never;
}

export interface NodeAccountSyncConnectionConfig extends ConnectionConfig {
  accountSync?: AccountSyncOptions<NodeSubscriptionTransport>;
}

export type AccountDataEncoding =
  | "binary"
  | "base58"
  | "base64"
  | "base64+zstd"
  | "jsonParsed";

export type EncodedAccountData =
  | string
  | [string, Exclude<AccountDataEncoding, "jsonParsed">]
  | ParsedAccountData;

export interface UiAccount {
  lamports: number;
  data: EncodedAccountData;
  owner: string;
  executable: boolean;
  rentEpoch: number;
  space?: number;
}

export interface AccountEncodingInput {
  pubkey: string | PublicKey;
  owner: string | PublicKey;
  lamports: number | bigint | string;
  executable: boolean;
  rentEpoch: number | bigint | string;
  data: Uint8Array | Buffer | string;
}

export interface BufferedAccountState {
  accountId: string;
  lamports: bigint;
  owner: string;
  executable: boolean;
  rentEpoch: bigint;
  data: Uint8Array;
  slot: bigint;
  writeVersion: bigint;
  updatedAtMs: number;
}

export interface AccountParseContextMint {
  pubkey: string | PublicKey;
  data: Uint8Array | Buffer | string;
}

export interface AccountParseContext {
  splTokenMint?: AccountParseContextMint;
  unixTimestamp?: number;
}

export interface AccountParseContextAccount {
  data: Uint8Array | Buffer | string;
}

export type AccountParseContextFetcher = (
  pubkey: PublicKey
) => Promise<AccountInfo<Buffer> | AccountParseContextAccount | null>;

export interface AccountEncodingOptions {
  dataSlice?: DataSlice;
  parseContext?: AccountParseContext;
  parseContextFetcher?: AccountParseContextFetcher;
  cache?: AccountParseContextCache;
  fallbackOnParseFailure?: boolean;
  unixTimestamp?: number;
}

export interface ConvertAccountDataOptions {}

export interface AccountParseContextCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
}

export declare class UnsupportedEncodingError extends Error {
  readonly pubkey?: string;
  readonly owner?: string;
  readonly encoding?: AccountDataEncoding;
}

export declare class InvalidAccountDataError extends Error {
  readonly pubkey?: string;
  readonly owner?: string;
  readonly encoding?: AccountDataEncoding;
}

export declare class MissingParseContextError extends Error {
  readonly pubkey?: string;
  readonly owner?: string;
  readonly encoding?: AccountDataEncoding;
  readonly missingAccounts: readonly string[];
  readonly contextKind?: string;
}

export declare class ContextFetchError extends Error {
  readonly pubkey?: string;
  readonly owner?: string;
  readonly encoding?: AccountDataEncoding;
  readonly missingAccount?: string;
  readonly contextKind?: string;
}

export declare class WasmParserError extends Error {
  readonly pubkey?: string;
  readonly owner?: string;
  readonly encoding?: AccountDataEncoding;
}

export declare class AccountParseContextCache {
  constructor(options?: AccountParseContextCacheOptions);
  get(pubkey: string | PublicKey): AccountParseContextAccount | null | undefined;
  set(pubkey: string | PublicKey, value: AccountParseContextAccount | null): void;
  getOrLoad(
    pubkey: string | PublicKey,
    loader: () => Promise<AccountParseContextAccount | null>
  ): Promise<AccountParseContextAccount | null>;
  clear(): void;
}

export declare function loadAccountEncodingWasm(): Promise<unknown>;
export declare function isBase64ZstdEncodingSupported(): boolean;
export declare function encodeAccount(
  input: AccountEncodingInput,
  encoding: AccountDataEncoding,
  options?: AccountEncodingOptions
): Promise<UiAccount>;
export declare function parseJsonParsed(
  input: AccountEncodingInput,
  options?: AccountEncodingOptions
): Promise<ParsedAccountData | [string, "base64"]>;
export declare function convertAccountData(
  input: string,
  from: AccountDataEncoding,
  to: AccountDataEncoding,
  options?: ConvertAccountDataOptions
): Promise<string>;
export declare function accountInfoToEncodingInput(
  pubkey: string | PublicKey,
  accountInfo: AccountInfo<Buffer>
): AccountEncodingInput;
export declare function bufferedAccountToEncodingInput(
  state: BufferedAccountState
): AccountEncodingInput;
export declare function toWeb3JsParsedAccountInfo(
  account: UiAccount
): AccountInfo<Buffer | ParsedAccountData>;

export declare class Connection extends Web3JsConnection {
  constructor(
    endpoint: string,
    commitmentOrConfig?: Commitment | NodeAccountSyncConnectionConfig
  );

  getAccountInfo(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig
  ): Promise<AccountInfo<Buffer> | null>;

  getAccountInfoAndContext(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>>;

  getParsedAccountInfo(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer | ParsedAccountData> | null>>;

  getMultipleParsedAccounts(
    publicKeys: PublicKey[],
    rawConfig?: GetMultipleAccountsConfig
  ): Promise<RpcResponseAndContext<(AccountInfo<Buffer | ParsedAccountData> | null)[]>>;

  getMultipleAccountsInfoAndContext(
    publicKeys: PublicKey[],
    commitmentOrConfig?: Commitment | GetMultipleAccountsConfig
  ): Promise<RpcResponseAndContext<(AccountInfo<Buffer> | null)[]>>;

  getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    commitmentOrConfig?: Commitment | GetMultipleAccountsConfig
  ): Promise<(AccountInfo<Buffer> | null)[]>;

  addAccounts(accountIds: ReadonlyArray<string | PublicKey>, commitment?: Commitment): Promise<void>;
  removeAccounts(accountIds: ReadonlyArray<string | PublicKey>, commitment?: Commitment): Promise<void>;
  setAccounts(accountIds: ReadonlyArray<string | PublicKey>, commitment?: Commitment): Promise<void>;
  close(): Promise<void>;
  getLastTransportError(): Error | null;
}
