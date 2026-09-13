import { Buffer } from "buffer";
import {
  PublicKey,
  type AccountInfo,
  type Commitment,
  type ConnectionConfig,
  type DataSlice,
  type GetAccountInfoConfig,
  type GetMultipleAccountsConfig
} from "@solana/web3.js";
import type {
  AccountSyncCommitment,
  AccountSyncOptions,
  AccountSyncTransports,
  BufferedAccountState,
  ResolvedGetAccountInfoOptions
} from "../core/types";

const DEFAULT_MISS_TIMEOUT_MS = 5_000;
const DEFAULT_RPC_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 100;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_DYNAMIC_SUBSCRIPTION_TTL_MS = 60_000;
const DEFAULT_GRPC_FLOW_CONTROL_WINDOW_BYTES = 16 * 1024 * 1024;
const DEFAULT_GRPC_MAX_RECEIVE_MESSAGE_LENGTH_BYTES = 16 * 1024 * 1024;
const DEFAULT_GRPC_KEEP_ALIVE_INTERVAL_MS = 30_000;
const DEFAULT_GRPC_KEEP_ALIVE_TIMEOUT_MS = 10_000;

interface CommitmentAndConfig<TConfig extends ConnectionConfig> {
  commitment: Commitment | undefined;
  config: TConfig;
}

export interface ResolvedAccountSyncSettings<TTransport extends AccountSyncTransports> {
  transport: TTransport;
  subscriptionEndpoint: string;
  commitment: AccountSyncCommitment;
  initialAccountIds: readonly string[];
  autoSubscribeOnMiss: boolean;
  missTimeoutMs: number;
  rpcPollIntervalMs: number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  connectTimeoutMs: number;
  closeTimeoutMs: number;
  dynamicSubscriptionTtlMs: number;
  grpc: {
    flowControlWindowBytes: number;
    maxReceiveMessageLengthBytes: number;
    keepAliveIntervalMs: number;
    keepAliveTimeoutMs: number;
    keepAlivePermitWithoutCalls: boolean;
  };
}

// What: Splits web3.js constructor union into commitment + config object.
// Why: Constructor accepts either commitment string or config object.
// How: Detect string vs object and return normalized pair.
export function splitCommitmentAndConfig<TConfig extends ConnectionConfig>(
  commitmentOrConfig: Commitment | TConfig | undefined
): CommitmentAndConfig<TConfig> {
  if (!commitmentOrConfig) {
    return {
      commitment: undefined,
      config: {} as TConfig
    };
  }

  if (typeof commitmentOrConfig === "string") {
    return {
      commitment: commitmentOrConfig,
      config: {} as TConfig
    };
  }

  return {
    commitment: commitmentOrConfig.commitment,
    config: commitmentOrConfig
  };
}

// What: Builds the argument passed to web3.js `Connection` constructor.
// Why: SDK config extends web3.js config with `accountSync`, which base constructor should not see.
// How: Strip `accountSync`; pass config object when non-empty, otherwise pass commitment.
export function buildWeb3JsConnectionCtorArg<
  TConfig extends ConnectionConfig & { accountSync?: unknown }
>(
  commitment: Commitment | undefined,
  config: TConfig
): Commitment | ConnectionConfig | undefined {
  const { accountSync: _accountSync, ...web3Config } = config;
  if (Object.keys(web3Config).length > 0) {
    return web3Config as ConnectionConfig;
  }

  return commitment;
}

// What: Normalizes mixed PublicKey/string array into base58 strings.
// Why: Internal registry and transport logic are key-string based.
// How: Parse each input via `PublicKey` and dedupe.
export function normalizeAccountIds(
  accountIds: ReadonlyArray<string | PublicKey>
): string[] {
  const normalized = new Set<string>();

  for (const accountId of accountIds) {
    const key = normalizeAccountId(accountId);
    normalized.add(key);
  }

  return [...normalized];
}

// What: Normalizes one account id into canonical base58 string.
// Why: Client-facing APIs should reject malformed pubkeys before opening/refreshing subscriptions.
// How: Parse strings with `PublicKey`; otherwise trust the object's `toBase58` method.
export function normalizeAccountId(accountId: string | PublicKey): string {
  if (typeof accountId === "string") {
    return new PublicKey(accountId).toBase58();
  }

  return accountId.toBase58();
}

// What: Converts HTTP(S) endpoint into WS(S) endpoint when ws endpoint is not provided.
// Why: Preserve web3.js-style constructor ergonomics for websocket transport.
// How: Parse URL and swap protocol from http->ws or https->wss.
export function deriveWebSocketEndpoint(endpoint: string): string {
  const normalizedEndpoint = endpoint.includes("://") ? endpoint : `http://${endpoint}`;
  const url = new URL(normalizedEndpoint);

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`invalid websocket endpoint protocol: ${url.protocol}`);
  }

  return url.toString();
}

// What: Resolves common account-sync options with defaults.
// Why: Keep constructor logic small and deterministic.
// How: Apply defaults for timeout, auto-subscribe, and initial accounts.
export function resolveAccountSyncSettings<TTransport extends AccountSyncTransports>(
  options: AccountSyncOptions<TTransport> | undefined,
  fallbackSubscriptionEndpoint: string,
  fallbackTransport: TTransport,
  fallbackCommitment: Commitment | undefined
): ResolvedAccountSyncSettings<TTransport> {
  const commitment =
    options?.commitment ??
    normalizeAccountSyncCommitment(fallbackCommitment) ??
    "confirmed";
  const reconnectInitialDelayMs = normalizePositiveSafeInteger(
    options?.reconnectInitialDelayMs,
    DEFAULT_RECONNECT_INITIAL_DELAY_MS,
    "accountSync.reconnectInitialDelayMs"
  );
  const reconnectMaxDelayMs = normalizePositiveSafeInteger(
    options?.reconnectMaxDelayMs,
    DEFAULT_RECONNECT_MAX_DELAY_MS,
    "accountSync.reconnectMaxDelayMs"
  );
  if (reconnectMaxDelayMs < reconnectInitialDelayMs) {
    throw new Error(
      "accountSync.reconnectMaxDelayMs must be greater than or equal to reconnectInitialDelayMs"
    );
  }

  return {
    transport: options?.transport ?? fallbackTransport,
    subscriptionEndpoint: options?.subscriptionEndpoint ?? fallbackSubscriptionEndpoint,
    commitment,
    initialAccountIds: normalizeAccountIds(options?.initialAccounts ?? []),
    autoSubscribeOnMiss: options?.autoSubscribeOnMiss ?? true,
    missTimeoutMs: normalizePositiveSafeInteger(
      options?.missTimeoutMs,
      DEFAULT_MISS_TIMEOUT_MS,
      "accountSync.missTimeoutMs"
    ),
    rpcPollIntervalMs: normalizePositiveSafeInteger(
      options?.rpcPollIntervalMs,
      DEFAULT_RPC_POLL_INTERVAL_MS,
      "accountSync.rpcPollIntervalMs"
    ),
    reconnectInitialDelayMs,
    reconnectMaxDelayMs,
    connectTimeoutMs: normalizePositiveSafeInteger(
      options?.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "accountSync.connectTimeoutMs"
    ),
    closeTimeoutMs: normalizePositiveSafeInteger(
      options?.closeTimeoutMs,
      DEFAULT_CLOSE_TIMEOUT_MS,
      "accountSync.closeTimeoutMs"
    ),
    dynamicSubscriptionTtlMs: normalizePositiveSafeInteger(
      options?.dynamicSubscriptionTtlMs,
      DEFAULT_DYNAMIC_SUBSCRIPTION_TTL_MS,
      "accountSync.dynamicSubscriptionTtlMs"
    ),
    grpc: {
      flowControlWindowBytes: normalizePositiveSafeInteger(
        options?.grpc?.flowControlWindowBytes,
        DEFAULT_GRPC_FLOW_CONTROL_WINDOW_BYTES,
        "accountSync.grpc.flowControlWindowBytes"
      ),
      maxReceiveMessageLengthBytes: normalizePositiveSafeInteger(
        options?.grpc?.maxReceiveMessageLengthBytes,
        DEFAULT_GRPC_MAX_RECEIVE_MESSAGE_LENGTH_BYTES,
        "accountSync.grpc.maxReceiveMessageLengthBytes"
      ),
      keepAliveIntervalMs: normalizePositiveSafeInteger(
        options?.grpc?.keepAliveIntervalMs,
        DEFAULT_GRPC_KEEP_ALIVE_INTERVAL_MS,
        "accountSync.grpc.keepAliveIntervalMs"
      ),
      keepAliveTimeoutMs: normalizePositiveSafeInteger(
        options?.grpc?.keepAliveTimeoutMs,
        DEFAULT_GRPC_KEEP_ALIVE_TIMEOUT_MS,
        "accountSync.grpc.keepAliveTimeoutMs"
      ),
      keepAlivePermitWithoutCalls: normalizeBoolean(
        options?.grpc?.keepAlivePermitWithoutCalls,
        true,
        "accountSync.grpc.keepAlivePermitWithoutCalls"
      )
    }
  };
}

function normalizeBoolean(
  value: boolean | undefined,
  fallback: boolean,
  name: string
): boolean {
  const resolved = value ?? fallback;
  if (typeof resolved !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return resolved;
}

function normalizePositiveSafeInteger(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return resolved;
}

// What: Resolves the commitment argument accepted by web3.js `getAccountInfo`.
// Why: The method accepts either a commitment string or a config object.
// How: Use `config.commitment` when present, otherwise fall back to connection commitment.
export function resolveGetAccountInfoCommitment(
  commitmentOrConfig: Commitment | { commitment?: Commitment } | undefined,
  fallbackCommitment: AccountSyncCommitment
): AccountSyncCommitment {
  return resolveGetAccountInfoOptions(
    commitmentOrConfig,
    fallbackCommitment
  ).commitment;
}

// What: Resolves all options accepted by web3.js `getAccountInfo`.
// Why: The SDK implements commitment, dataSlice, and minContextSlot from the same config object.
// How: Keep string commitment syntax, validate numeric options, and return normalized settings.
export function resolveGetAccountInfoOptions(
  commitmentOrConfig: Commitment | GetAccountInfoConfig | undefined,
  fallbackCommitment: AccountSyncCommitment
): ResolvedGetAccountInfoOptions {
  return resolveAccountReadOptions(
    commitmentOrConfig,
    fallbackCommitment,
    "getAccountInfo"
  );
}

// What: Resolves all options accepted by web3.js `getMultipleAccountsInfo`.
// Why: The method shares account-read config semantics with `getAccountInfo`.
// How: Reuse the same validation while keeping method-specific error messages.
export function resolveGetMultipleAccountsInfoOptions(
  commitmentOrConfig: Commitment | GetMultipleAccountsConfig | undefined,
  fallbackCommitment: AccountSyncCommitment
): ResolvedGetAccountInfoOptions {
  return resolveAccountReadOptions(
    commitmentOrConfig,
    fallbackCommitment,
    "getMultipleAccountsInfo"
  );
}

function resolveAccountReadOptions(
  commitmentOrConfig:
    | Commitment
    | GetAccountInfoConfig
    | GetMultipleAccountsConfig
    | undefined,
  fallbackCommitment: AccountSyncCommitment,
  methodName: string
): ResolvedGetAccountInfoOptions {
  const commitment =
    typeof commitmentOrConfig === "string"
      ? commitmentOrConfig
      : commitmentOrConfig?.commitment;
  const normalized = normalizeAccountSyncCommitment(commitment);
  if (normalized) {
    return {
      commitment: normalized,
      dataSlice:
        typeof commitmentOrConfig === "string"
          ? undefined
          : normalizeDataSlice(commitmentOrConfig?.dataSlice, methodName),
      minContextSlot:
        typeof commitmentOrConfig === "string"
          ? undefined
          : normalizeMinContextSlot(commitmentOrConfig?.minContextSlot, methodName)
    };
  }

  if (commitment) {
    throw new Error(
      `unsupported account-sync commitment '${commitment}': expected processed, confirmed, or finalized`
    );
  }

  return {
    commitment: fallbackCommitment,
    dataSlice:
      typeof commitmentOrConfig === "string"
        ? undefined
        : normalizeDataSlice(commitmentOrConfig?.dataSlice, methodName),
    minContextSlot:
      typeof commitmentOrConfig === "string"
        ? undefined
        : normalizeMinContextSlot(commitmentOrConfig?.minContextSlot, methodName)
  };
}

// What: Converts buffered account state into web3.js `AccountInfo<Buffer>` shape.
// Why: SDK must return same output schema as `Connection.getAccountInfo`.
// How: Map normalized buffered fields to web3.js account object fields.
export function toWeb3JsAccountInfo(
  state: BufferedAccountState,
  dataSlice?: DataSlice
): AccountInfo<Buffer> {
  return {
    executable: state.executable,
    owner: new PublicKey(state.owner),
    lamports: Number(state.lamports),
    data: sliceAccountData(state.data, dataSlice),
    rentEpoch: Number(state.rentEpoch),
    // space: state.data.length
  } as AccountInfo<Buffer>;
}

// What: Converts buffered slot bigint into web3.js context slot number.
// Why: `RpcResponseAndContext` requires `slot: number` but buffered state stores bigint.
export function toWeb3JsContextSlot(slot: bigint): number {
  return Number(slot);
}

function normalizeDataSlice(
  dataSlice: DataSlice | undefined,
  methodName: string
): DataSlice | undefined {
  if (!dataSlice) {
    return undefined;
  }

  assertNonNegativeSafeInteger(methodName, "dataSlice.offset", dataSlice.offset);
  assertNonNegativeSafeInteger(methodName, "dataSlice.length", dataSlice.length);

  return {
    offset: dataSlice.offset,
    length: dataSlice.length
  };
}

function normalizeMinContextSlot(
  minContextSlot: number | undefined,
  methodName: string
): number | undefined {
  if (minContextSlot === undefined) {
    return undefined;
  }

  assertNonNegativeSafeInteger(methodName, "minContextSlot", minContextSlot);
  return minContextSlot;
}

function assertNonNegativeSafeInteger(
  methodName: string,
  name: string,
  value: number
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `invalid ${methodName} ${name}: expected a non-negative safe integer`
    );
  }
}

function sliceAccountData(data: Uint8Array, dataSlice: DataSlice | undefined): Buffer {
  if (!dataSlice) {
    return Buffer.from(data);
  }

  const end =
    dataSlice.length > Number.MAX_SAFE_INTEGER - dataSlice.offset
      ? Number.MAX_SAFE_INTEGER
      : dataSlice.offset + dataSlice.length;

  return Buffer.from(data.subarray(dataSlice.offset, end));
}

function normalizeAccountSyncCommitment(
  commitment: Commitment | undefined
): AccountSyncCommitment | undefined {
  if (
    commitment === "processed" ||
    commitment === "confirmed" ||
    commitment === "finalized"
  ) {
    return commitment;
  }

  return undefined;
}
