import type { Commitment, ConnectionConfig, DataSlice, PublicKey } from "@solana/web3.js";

/** A commitment level supported by the account-sync buffer. */
export type AccountSyncCommitment = "processed" | "confirmed" | "finalized";

/** Subscription transports supported by the SDK. */
export enum AccountSyncTransports {
  /** Yellowstone account-sync over WebSocket. */
  WS = "ws",
  /** Yellowstone account-sync over gRPC. Available only in Node.js. */
  GRPC = "grpc"
}

/** Subscription transports available in the Node.js build. */
export type NodeSubscriptionTransport =
  | AccountSyncTransports.WS
  | AccountSyncTransports.GRPC;

/** Subscription transports available in the browser build. */
export type BrowserSubscriptionTransport = AccountSyncTransports.WS;

/** Options for the Node.js gRPC subscription transport. */
export interface GrpcTransportOptions {
  /** HTTP/2 flow-control window in bytes. Defaults to 16 MiB. */
  flowControlWindowBytes?: number;
  /** Largest gRPC message the client will accept, in bytes. Defaults to 16 MiB. */
  maxReceiveMessageLengthBytes?: number;
  /** Time between gRPC keepalive pings, in milliseconds. Defaults to 30 seconds. */
  keepAliveIntervalMs?: number;
  /** Time to wait for a keepalive response, in milliseconds. Defaults to 10 seconds. */
  keepAliveTimeoutMs?: number;
  /** Whether to send keepalive pings when there are no active calls. Defaults to `true`. */
  keepAlivePermitWithoutCalls?: boolean;
}

/**
 * Configures the local account-sync buffer used by {@link Connection} account reads.
 *
 * Options belong in the `accountSync` property of the connection configuration.
 * All time values are in milliseconds and must be positive safe integers.
 */
export interface AccountSyncOptions<TTransport extends AccountSyncTransports> {
  /** Subscription transport. Defaults to WebSocket. */
  transport?: TTransport;
  /**
   * Account-sync endpoint override.
   *
   * When omitted, a WebSocket endpoint is derived from the RPC endpoint, while
   * gRPC uses the RPC endpoint host.
   */
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
  /** Node.js gRPC settings. Valid only when `transport` is `AccountSyncTransports.GRPC`. */
  grpc?: TTransport extends AccountSyncTransports.GRPC
    ? GrpcTransportOptions
    : never;
}

/** web3.js connection configuration extended with Node.js account-sync options. */
export interface NodeAccountSyncConnectionConfig extends ConnectionConfig {
  /** Local account-sync buffer and subscription settings. */
  accountSync?: AccountSyncOptions<NodeSubscriptionTransport>;
}

/** web3.js connection configuration extended with browser account-sync options. */
export interface BrowserAccountSyncConnectionConfig extends ConnectionConfig {
  /** Local account-sync buffer and WebSocket subscription settings. */
  accountSync?: AccountSyncOptions<BrowserSubscriptionTransport>;
}

/** Second argument accepted by the Node.js {@link Connection} constructor. */
export type NodeCommitmentOrConfig =
  | Commitment
  | NodeAccountSyncConnectionConfig
  | undefined;

/** Second argument accepted by the browser {@link Connection} constructor. */
export type BrowserCommitmentOrConfig =
  | Commitment
  | BrowserAccountSyncConnectionConfig
  | undefined;

/** A decoded account update received from an account-sync transport. */
export interface DecodedAccountUpdate {
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
}

/** Latest decoded account update together with its local arrival time. */
export interface BufferedAccountState extends DecodedAccountUpdate {
  /** Unix time in milliseconds when the buffer accepted the update. */
  updatedAtMs: number;
}

/** Constraints applied while resolving an account from the local buffer. */
export interface AccountReadConstraints {
  /** Lowest observation slot that can satisfy the read. */
  minContextSlot?: number;
}

/** Validated options used internally for a buffered account read. */
export interface ResolvedGetAccountInfoOptions extends AccountReadConstraints {
  /** Commitment buffer to read. */
  commitment: AccountSyncCommitment;
  /** Byte range to return from the account data. */
  dataSlice?: DataSlice;
}
