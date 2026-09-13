import { Buffer } from "buffer";
import {
  PublicKey,
  type AccountInfo,
  type DataSlice,
  type ParsedAccountData
} from "@solana/web3.js";
import initAccountEncodingWasm, {
  convert_account_data,
  encode_account,
  parse_account_json,
  WasmUiAccountEncoding
} from "./wasm/account_encoding/yellowstone_account_sync_account_encoding_wasm.js";
import type { BufferedAccountState } from "./core/types";

/**
 * Account data encodings accepted by the encoding helpers.
 *
 * `"binary"` is Solana's legacy name for base58. `"base64+zstd"` is a
 * zstd-compressed byte sequence represented as base64.
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
 * Legacy `"binary"` output is a plain base58 string. Other raw encodings use an
 * `[encodedData, encoding]` tuple. Parsed output uses the web3.js
 * {@link ParsedAccountData} shape.
 */
export type EncodedAccountData =
  | string
  | [string, Exclude<AccountDataEncoding, "jsonParsed">]
  | ParsedAccountData;

/** JSON-compatible account information in Solana RPC response form. */
export interface UiAccount {
  /** Account balance in lamports. */
  lamports: number;
  /** Account data encoded in the requested form. */
  data: EncodedAccountData;
  /** Base58 address of the program that owns the account. */
  owner: string;
  /** Whether the account contains an executable program. */
  executable: boolean;
  /** Epoch at which the account will next owe rent. */
  rentEpoch: number;
  /** Full account data size in bytes, even when `dataSlice` is used. */
  space?: number;
}

/** Raw account values accepted by {@link encodeAccount} and {@link parseJsonParsed}. */
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
 * Return `null` when the requested account does not exist.
 *
 * @param pubkey Address of the context account to load.
 * @returns Account data, or `null` when the account does not exist.
 */
export type AccountParseContextFetcher = (
  pubkey: PublicKey
) => Promise<AccountInfo<Buffer> | AccountParseContextAccount | null>;

/** Options shared by {@link encodeAccount} and {@link parseJsonParsed}. */
export interface AccountEncodingOptions {
  /** Byte range to return for raw encodings. `space` still reports the full data size. */
  dataSlice?: DataSlice;
  /** Parser inputs already available to the caller. */
  parseContext?: AccountParseContext;
  /** Loader used when parsing reports that another account is required. */
  parseContextFetcher?: AccountParseContextFetcher;
  /** Cache used for accounts loaded through `parseContextFetcher`. */
  cache?: AccountParseContextCache;
  /**
   * Whether parsing errors should return raw base64 data instead of rejecting.
   * Defaults to `true` for {@link encodeAccount} and `false` for
   * {@link parseJsonParsed}.
   */
  fallbackOnParseFailure?: boolean;
  /** Unix time in seconds. Overrides `parseContext.unixTimestamp`. */
  unixTimestamp?: number;
  /** @internal Allows tests to inject a parser without changing global WASM state. */
  wasm?: AccountEncodingWasm;
}

/** Options for {@link convertAccountData}. */
export interface ConvertAccountDataOptions {
  /** @internal Allows tests to inject a parser without changing global WASM state. */
  wasm?: AccountEncodingWasm;
}

/** Metadata attached to account encoding errors. */
export interface AccountEncodingErrorMetadata {
  /** Base58 address of the account being encoded. */
  pubkey?: string;
  /** Base58 address of the owning program. */
  owner?: string;
  /** Requested output encoding. */
  encoding?: AccountDataEncoding;
  /** Original value that caused this error, when available. */
  cause?: unknown;
}

/** Thrown when an encoding or account parser is not supported. */
export class UnsupportedEncodingError extends Error {
  /** Base58 address of the account being encoded, when available. */
  readonly pubkey?: string;
  /** Base58 address of the owning program, when available. */
  readonly owner?: string;
  /** Requested output encoding, when available. */
  readonly encoding?: AccountDataEncoding;
  /** Original value that caused this error, when available. */
  readonly cause?: unknown;

  /**
   * @param message Human-readable description of the failure.
   * @param metadata Account and encoding details attached to the error.
   */
  constructor(message: string, metadata: AccountEncodingErrorMetadata = {}) {
    super(message);
    this.name = "UnsupportedEncodingError";
    this.pubkey = metadata.pubkey;
    this.owner = metadata.owner;
    this.encoding = metadata.encoding;
    this.cause = metadata.cause;
  }
}

/** Thrown when account fields or encoded data cannot be validated or decoded. */
export class InvalidAccountDataError extends Error {
  /** Base58 address of the account being encoded, when available. */
  readonly pubkey?: string;
  /** Base58 address of the owning program, when available. */
  readonly owner?: string;
  /** Requested output encoding, when available. */
  readonly encoding?: AccountDataEncoding;
  /** Original value that caused this error, when available. */
  readonly cause?: unknown;

  /**
   * @param message Human-readable description of the failure.
   * @param metadata Account and encoding details attached to the error.
   */
  constructor(message: string, metadata: AccountEncodingErrorMetadata = {}) {
    super(message);
    this.name = "InvalidAccountDataError";
    this.pubkey = metadata.pubkey;
    this.owner = metadata.owner;
    this.encoding = metadata.encoding;
    this.cause = metadata.cause;
  }
}

/**
 * Thrown when parsed output needs account data that was not supplied and could
 * not be loaded.
 */
export class MissingParseContextError extends Error {
  /** Base58 address of the account being parsed, when available. */
  readonly pubkey?: string;
  /** Base58 address of the owning program, when available. */
  readonly owner?: string;
  /** Requested output encoding, when available. */
  readonly encoding?: AccountDataEncoding;
  /** Addresses of the accounts required to continue parsing. */
  readonly missingAccounts: readonly string[];
  /** Parser-specific name for the missing context, such as an SPL token mint. */
  readonly contextKind?: string;
  /** Original value that caused this error, when available. */
  readonly cause?: unknown;

  /**
   * @param message Human-readable description of the failure.
   * @param metadata Missing addresses and account details attached to the error.
   */
  constructor(
    message: string,
    metadata: AccountEncodingErrorMetadata & {
      missingAccounts?: readonly string[];
      contextKind?: string;
    } = {}
  ) {
    super(message);
    this.name = "MissingParseContextError";
    this.pubkey = metadata.pubkey;
    this.owner = metadata.owner;
    this.encoding = metadata.encoding;
    this.missingAccounts = metadata.missingAccounts ?? [];
    this.contextKind = metadata.contextKind;
    this.cause = metadata.cause;
  }
}

/** Thrown when an {@link AccountParseContextFetcher} fails. */
export class ContextFetchError extends Error {
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
  /** Original value that caused this error, when available. */
  readonly cause?: unknown;

  /**
   * @param message Human-readable description of the failure.
   * @param metadata Requested context and account details attached to the error.
   */
  constructor(
    message: string,
    metadata: AccountEncodingErrorMetadata & {
      missingAccount?: string;
      contextKind?: string;
    } = {}
  ) {
    super(message);
    this.name = "ContextFetchError";
    this.pubkey = metadata.pubkey;
    this.owner = metadata.owner;
    this.encoding = metadata.encoding;
    this.missingAccount = metadata.missingAccount;
    this.contextKind = metadata.contextKind;
    this.cause = metadata.cause;
  }
}

/** Thrown when the account encoding WASM module fails unexpectedly. */
export class WasmParserError extends Error {
  /** Base58 address of the account being encoded, when available. */
  readonly pubkey?: string;
  /** Base58 address of the owning program, when available. */
  readonly owner?: string;
  /** Requested output encoding, when available. */
  readonly encoding?: AccountDataEncoding;
  /** Original value that caused this error, when available. */
  readonly cause?: unknown;

  /**
   * @param message Human-readable description of the failure.
   * @param metadata Account and encoding details attached to the error.
   */
  constructor(message: string, metadata: AccountEncodingErrorMetadata = {}) {
    super(message);
    this.name = "WasmParserError";
    this.pubkey = metadata.pubkey;
    this.owner = metadata.owner;
    this.encoding = metadata.encoding;
    this.cause = metadata.cause;
  }
}

/** Options for {@link AccountParseContextCache}. */
export interface AccountParseContextCacheOptions {
  /** Maximum cached accounts. Least-recently-used entries are removed first. Defaults to 256. */
  maxEntries?: number;
  /** Time a cached account or missing-account result remains valid. Defaults to 5 minutes. */
  ttlMs?: number;
}

interface CacheEntry {
  value: AccountParseContextAccount | null;
  expiresAtMs: number;
}

/**
 * A bounded cache for accounts loaded to support parsed account output.
 *
 * The cache stores `null` results, refreshes recency on reads, and shares one
 * in-flight load among concurrent callers for the same address.
 */
export class AccountParseContextCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<AccountParseContextAccount | null>
  >();
  private readonly inFlightTokens = new Map<string, object>();

  /**
   * Creates a parse-context cache.
   *
   * @throws `Error` if `maxEntries` or `ttlMs` is not a positive safe integer.
   */
  constructor(options: AccountParseContextCacheOptions = {}) {
    this.maxEntries = validatePositiveInteger(
      options.maxEntries ?? 256,
      "maxEntries"
    );
    this.ttlMs = validatePositiveInteger(options.ttlMs ?? 300_000, "ttlMs");
  }

  /**
   * Reads and refreshes a cached entry.
   *
   * @param pubkey Address of the context account.
   * @returns The cached account, `null` for a cached missing account, or
   * `undefined` when no unexpired entry exists.
   */
  get(pubkey: string | PublicKey): AccountParseContextAccount | null | undefined {
    const key = normalizePubkey(pubkey);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Stores an account or a known missing-account result.
   *
   * @param pubkey Address of the context account.
   * @param value Account data, or `null` when the account does not exist.
   */
  set(
    pubkey: string | PublicKey,
    value: AccountParseContextAccount | null
  ): void {
    const key = normalizePubkey(pubkey);
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAtMs: Date.now() + this.ttlMs
    });
    this.evictOldest();
  }

  /**
   * Returns a cached account or loads and caches it.
   *
   * Concurrent calls for the same uncached address share the same loader call.
   * Loader failures are not cached.
   *
   * @param pubkey Address of the context account.
   * @param loader Function that loads the account when it is not cached.
   * @returns The loaded account, or `null` when it does not exist.
   */
  async getOrLoad(
    pubkey: string | PublicKey,
    loader: () => Promise<AccountParseContextAccount | null>
  ): Promise<AccountParseContextAccount | null> {
    const key = normalizePubkey(pubkey);
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const token = {};
    const inFlight = loader().then((value) => {
      if (this.inFlightTokens.get(key) === token) {
        this.set(key, value);
      }
      return value;
    });
    this.inFlight.set(key, inFlight);
    this.inFlightTokens.set(key, token);

    try {
      return await inFlight;
    } finally {
      if (this.inFlight.get(key) === inFlight) {
        this.inFlight.delete(key);
      }
      if (this.inFlightTokens.get(key) === token) {
        this.inFlightTokens.delete(key);
      }
    }
  }

  /**
   * Removes a cached value and prevents an in-flight load from repopulating it.
   *
   * @param pubkey Address of the context account to remove.
   * @returns `true` if a stored cache entry was removed.
   */
  delete(pubkey: string | PublicKey): boolean {
    const key = normalizePubkey(pubkey);
    this.inFlight.delete(key);
    this.inFlightTokens.delete(key);
    return this.entries.delete(key);
  }

  /** Removes all cached values and detaches all in-flight loads. */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.inFlightTokens.clear();
  }

  private evictOldest(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.entries.delete(oldest);
    }
  }
}

/** Internal interface implemented by the account encoding WASM bindings. */
export interface AccountEncodingWasm {
  encode_account(
    accountJson: string,
    encoding: WasmUiAccountEncoding,
    contextJson?: string | null,
    dataSliceJson?: string | null
  ): string;
  parse_account_json(accountJson: string, contextJson?: string | null): string;
  convert_account_data(
    input: string,
    from: WasmUiAccountEncoding,
    to: WasmUiAccountEncoding
  ): string;
}

interface NormalizedAccountInput {
  pubkey: string;
  owner: string;
  lamports: string;
  executable: boolean;
  rentEpoch: string;
  data: string;
  dataBytes: Buffer;
}

interface WasmErrorPayload {
  code?: string;
  message?: string;
  pubkey?: string;
  owner?: string;
  encoding?: AccountDataEncoding;
  missingContext?: {
    missingAccounts?: string[];
    contextKind?: string;
  };
}

const WASM_FILE_URL = new URL(
  "./wasm/account_encoding/yellowstone_account_sync_account_encoding_wasm_bg.wasm",
  import.meta.url
);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const U64_MAX = (1n << 64n) - 1n;

let wasmInitPromise: Promise<AccountEncodingWasm> | undefined;

/**
 * Reports whether this build supports the `"base64+zstd"` encoding.
 *
 * @returns `true` for the bundled WASM encoder.
 */
export function isBase64ZstdEncodingSupported(): boolean {
  return true;
}

/**
 * Loads and initializes the bundled account encoding WASM module.
 *
 * Initialization is lazy and shared by all callers.
 *
 * @returns The initialized encoding functions.
 * @throws `Error` when the WASM file cannot be loaded or initialized.
 */
export async function loadAccountEncodingWasm(): Promise<AccountEncodingWasm> {
  if (!wasmInitPromise) {
    wasmInitPromise = initializeWasm();
  }

  return wasmInitPromise;
}

/**
 * Encodes raw account values in Solana RPC account form.
 *
 * `"jsonParsed"` output can load extra account data through
 * `options.parseContextFetcher`. Unsupported parsers return raw base64 data by
 * default. Set `fallbackOnParseFailure` to `false` to receive a typed error.
 *
 * @param input Raw account values to encode.
 * @param encoding Requested account data encoding.
 * @param options Data slicing and parsed-account context options.
 * @returns A JSON-compatible account value in the requested encoding.
 * @throws {@link UnsupportedEncodingError} when the requested encoding or parser is unsupported.
 * @throws {@link InvalidAccountDataError} when an account field or encoded value is invalid.
 * @throws {@link MissingParseContextError} when parsing needs context that is unavailable.
 * @throws {@link ContextFetchError} when loading parse context fails.
 * @throws {@link WasmParserError} when the bundled parser fails unexpectedly.
 *
 * @example
 * ```ts
 * const encoded = await encodeAccount(
 *   accountInfoToEncodingInput(address, accountInfo),
 *   "base64"
 * );
 * console.log(encoded.data);
 * ```
 */
export async function encodeAccount(
  input: AccountEncodingInput,
  encoding: AccountDataEncoding,
  options: AccountEncodingOptions = {}
): Promise<UiAccount> {
  const normalizedEncoding = normalizeEncoding(encoding);
  const account = normalizeAccountInput(input, normalizedEncoding);
  const wasm = options.wasm ?? (await loadAccountEncodingWasm());

  if (normalizedEncoding !== "jsonParsed") {
    try {
      return parseWasmJson<UiAccount>(
        wasm.encode_account(
          accountPayloadJson(account),
          toWasmEncoding(normalizedEncoding),
          null,
          dataSliceJson(options.dataSlice)
        )
      );
    } catch (error) {
      throw mapWasmError(error, {
        pubkey: account.pubkey,
        owner: account.owner,
        encoding: normalizedEncoding
      });
    }
  }

  const fallbackOnParseFailure = options.fallbackOnParseFailure ?? true;
  return runWithParseContext<UiAccount>(
    account,
    normalizedEncoding,
    options,
    (contextJson) =>
      parseWasmJson<UiAccount>(
        wasm.encode_account(
          accountPayloadJson(account),
          WasmUiAccountEncoding.JsonParsed,
          contextJson,
          dataSliceJson(options.dataSlice)
        )
      ),
    () => buildJsonParsedFallback(account, options.dataSlice),
    fallbackOnParseFailure
  );
}

/**
 * Parses raw account values using Solana's program-aware account parsers.
 *
 * Unlike {@link encodeAccount}, this function rejects on parse failure by
 * default. Set `fallbackOnParseFailure` to `true` to receive raw base64 data.
 *
 * @param input Raw account values to parse.
 * @param options Parser context, loader, cache, and fallback settings.
 * @returns Parsed account data, or a base64 tuple when fallback is enabled.
 * @throws {@link InvalidAccountDataError} when an account field is invalid.
 * @throws {@link MissingParseContextError} when parsing needs context that is unavailable.
 * @throws {@link ContextFetchError} when loading parse context fails.
 * @throws {@link WasmParserError} when the bundled parser fails unexpectedly.
 */
export async function parseJsonParsed(
  input: AccountEncodingInput,
  options: AccountEncodingOptions = {}
): Promise<ParsedAccountData | [string, "base64"]> {
  const account = normalizeAccountInput(input, "jsonParsed");
  const wasm = options.wasm ?? (await loadAccountEncodingWasm());
  const fallbackOnParseFailure = options.fallbackOnParseFailure ?? false;

  return runWithParseContext<ParsedAccountData | [string, "base64"]>(
    account,
    "jsonParsed",
    options,
    (contextJson) =>
      parseWasmJson<ParsedAccountData>(
        wasm.parse_account_json(accountPayloadJson(account), contextJson)
      ),
    () => [account.data, "base64"],
    fallbackOnParseFailure
  );
}

/**
 * Converts raw account data between binary encodings.
 *
 * `"binary"` is the legacy name for base58. Parsed JSON cannot be used as an
 * input or output because it is not a raw byte encoding.
 *
 * @param input Account data encoded using `from`.
 * @param from Current encoding of `input`.
 * @param to Encoding to produce.
 * @param options Reserved conversion options.
 * @returns The same account bytes encoded using `to`.
 * @throws {@link UnsupportedEncodingError} when either encoding is `"jsonParsed"`.
 * @throws {@link InvalidAccountDataError} when `input` is invalid for `from`.
 *
 * @example
 * ```ts
 * const base58Data = await convertAccountData(base64Data, "base64", "base58");
 * ```
 */
export async function convertAccountData(
  input: string,
  from: AccountDataEncoding,
  to: AccountDataEncoding,
  options: ConvertAccountDataOptions = {}
): Promise<string> {
  const fromEncoding = normalizeEncoding(from);
  const toEncoding = normalizeEncoding(to);
  if (fromEncoding === "jsonParsed" || toEncoding === "jsonParsed") {
    throw new UnsupportedEncodingError(
      "jsonParsed account data cannot be converted as raw bytes",
      { encoding: toEncoding }
    );
  }

  const wasm = options.wasm ?? (await loadAccountEncodingWasm());
  try {
    return wasm.convert_account_data(
      input,
      toWasmEncoding(fromEncoding),
      toWasmEncoding(toEncoding)
    );
  } catch (error) {
    throw mapWasmError(error, { encoding: toEncoding });
  }
}

/**
 * Converts a buffered account into input accepted by {@link encodeAccount}.
 *
 * @param state Account state from the local account-sync buffer.
 * @returns A view of the account values without buffer bookkeeping fields.
 */
export function bufferedAccountToEncodingInput(
  state: BufferedAccountState
): AccountEncodingInput {
  return {
    pubkey: state.accountId,
    owner: state.owner,
    lamports: state.lamports,
    executable: state.executable,
    rentEpoch: state.rentEpoch,
    data: state.data
  };
}

/**
 * Converts web3.js account information into input accepted by {@link encodeAccount}.
 *
 * @param pubkey Address associated with `accountInfo`.
 * @param accountInfo Raw web3.js account information.
 * @returns The account values in encoder input form.
 */
export function accountInfoToEncodingInput(
  pubkey: string | PublicKey,
  accountInfo: AccountInfo<Buffer>
): AccountEncodingInput {
  return {
    pubkey,
    owner: accountInfo.owner,
    lamports: accountInfo.lamports,
    executable: accountInfo.executable,
    rentEpoch: accountInfo.rentEpoch ?? 0,
    data: accountInfo.data
  };
}

/**
 * Converts a JSON-compatible account into the web3.js parsed account shape.
 *
 * @param account Account returned by {@link encodeAccount} using `"jsonParsed"`.
 * @returns Account information with a `PublicKey` owner and parsed or raw data.
 * @throws {@link UnsupportedEncodingError} when `account.data` is not a supported parsed-account shape.
 */
export function toWeb3JsParsedAccountInfo(
  account: UiAccount
): AccountInfo<Buffer | ParsedAccountData> {
  return {
    executable: account.executable,
    owner: new PublicKey(account.owner),
    lamports: account.lamports,
    data: toWeb3JsParsedAccountData(account.data, {
      owner: account.owner,
      encoding: "jsonParsed"
    }),
    rentEpoch: account.rentEpoch
  };
}

async function initializeWasm(): Promise<AccountEncodingWasm> {
  await initAccountEncodingWasm({ module_or_path: await resolveWasmInitInput() });
  return {
    encode_account,
    parse_account_json,
    convert_account_data
  };
}

async function resolveWasmInitInput(): Promise<URL | Buffer> {
  if (!isNodeRuntime()) {
    return WASM_FILE_URL;
  }

  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    import("node:fs/promises"),
    import("node:url")
  ]);
  return readFile(fileURLToPath(WASM_FILE_URL));
}

function isNodeRuntime(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.versions === "object" &&
    typeof process.versions.node === "string"
  );
}

async function runWithParseContext<T>(
  account: NormalizedAccountInput,
  encoding: AccountDataEncoding,
  options: AccountEncodingOptions,
  run: (contextJson: string | null) => T,
  fallback: () => T,
  fallbackOnParseFailure: boolean
): Promise<T> {
  const baseContext = normalizeParseContext(options);
  try {
    return run(contextJson(baseContext));
  } catch (error) {
    const mapped = mapWasmError(error, {
      pubkey: account.pubkey,
      owner: account.owner,
      encoding
    });
    if (!(mapped instanceof MissingParseContextError)) {
      if (fallbackOnParseFailure && shouldFallbackOnJsonParsedError(mapped)) {
        return fallback();
      }
      throw mapped;
    }

    const resolvedContext = await resolveMissingParseContext(
      mapped,
      options,
      account,
      encoding,
      baseContext,
      fallbackOnParseFailure
    );
    if (!resolvedContext) {
      return fallback();
    }

    try {
      return run(contextJson(resolvedContext));
    } catch (retryError) {
      const mappedRetry = mapWasmError(retryError, {
        pubkey: account.pubkey,
        owner: account.owner,
        encoding
      });
      if (fallbackOnParseFailure && shouldFallbackOnJsonParsedError(mappedRetry)) {
        return fallback();
      }
      throw mappedRetry;
    }
  }
}

function shouldFallbackOnJsonParsedError(error: Error): boolean {
  return (
    error instanceof MissingParseContextError ||
    error instanceof ContextFetchError ||
    error instanceof WasmParserError
  );
}

async function resolveMissingParseContext(
  error: MissingParseContextError,
  options: AccountEncodingOptions,
  account: NormalizedAccountInput,
  encoding: AccountDataEncoding,
  baseContext: AccountParseContext | undefined,
  fallbackOnParseFailure: boolean
): Promise<AccountParseContext | undefined> {
  const missingAccount = error.missingAccounts[0];
  if (!missingAccount || error.contextKind !== "splTokenMint") {
    if (fallbackOnParseFailure) {
      return undefined;
    }
    throw error;
  }

  if (!options.parseContextFetcher) {
    if (fallbackOnParseFailure) {
      return undefined;
    }
    throw error;
  }

  let fetched: AccountParseContextAccount | null;
  try {
    const load = () => fetchParseContextAccount(missingAccount, options);
    fetched = options.cache
      ? await options.cache.getOrLoad(missingAccount, load)
      : await load();
  } catch (cause) {
    const fetchError = new ContextFetchError(
      `failed to fetch parse context account ${missingAccount}`,
      {
        pubkey: account.pubkey,
        owner: account.owner,
        encoding,
        missingAccount,
        contextKind: error.contextKind,
        cause
      }
    );
    if (fallbackOnParseFailure) {
      return undefined;
    }
    throw fetchError;
  }

  if (!fetched) {
    const fetchError = new ContextFetchError(
      `parse context account ${missingAccount} is unavailable`,
      {
        pubkey: account.pubkey,
        owner: account.owner,
        encoding,
        missingAccount,
        contextKind: error.contextKind
      }
    );
    if (fallbackOnParseFailure) {
      return undefined;
    }
    throw fetchError;
  }

  return {
    ...baseContext,
    splTokenMint: {
      pubkey: missingAccount,
      data: contextDataToBase64(fetched.data)
    }
  };
}

async function fetchParseContextAccount(
  pubkey: string,
  options: AccountEncodingOptions
): Promise<AccountParseContextAccount | null> {
  if (!options.parseContextFetcher) {
    return null;
  }

  const account = await options.parseContextFetcher(new PublicKey(pubkey));
  if (!account) {
    return null;
  }

  return {
    data: account.data
  };
}

function normalizeAccountInput(
  input: AccountEncodingInput,
  encoding: AccountDataEncoding
): NormalizedAccountInput {
  const pubkey = normalizePubkeyOrThrow(input.pubkey, "account pubkey", {
    encoding
  });
  const owner = normalizePubkeyOrThrow(input.owner, "account owner", {
    pubkey,
    encoding
  });
  const dataBytes =
    typeof input.data === "string" ? Buffer.from(input.data, "base64") : toBuffer(input.data);
  return {
    pubkey,
    owner,
    lamports: toU64String(input.lamports, "lamports", { pubkey, owner, encoding }),
    executable: input.executable,
    rentEpoch: toU64String(input.rentEpoch, "rentEpoch", {
      pubkey,
      owner,
      encoding
    }),
    data: typeof input.data === "string" ? input.data : dataBytes.toString("base64"),
    dataBytes
  };
}

function normalizeParseContext(
  options: AccountEncodingOptions
): AccountParseContext | undefined {
  const source = options.parseContext;
  const unixTimestamp = options.unixTimestamp ?? source?.unixTimestamp;
  const normalized: AccountParseContext = {};

  if (source?.splTokenMint) {
    normalized.splTokenMint = {
      pubkey: normalizePubkeyOrThrow(source.splTokenMint.pubkey, "SPL token mint pubkey", {
        encoding: "jsonParsed"
      }),
      data: contextDataToBase64(source.splTokenMint.data)
    };
  }

  if (unixTimestamp !== undefined) {
    if (!Number.isSafeInteger(unixTimestamp)) {
      throw new InvalidAccountDataError(
        "unixTimestamp must be a safe integer when provided",
        { encoding: "jsonParsed" }
      );
    }
    normalized.unixTimestamp = unixTimestamp;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function accountPayloadJson(account: NormalizedAccountInput): string {
  return JSON.stringify({
    pubkey: account.pubkey,
    owner: account.owner,
    lamports: account.lamports,
    executable: account.executable,
    rentEpoch: account.rentEpoch,
    data: account.data
  });
}

function contextDataToBase64(data: Uint8Array | Buffer | string): string {
  return typeof data === "string" ? data : toBuffer(data).toString("base64");
}

function contextJson(context: AccountParseContext | undefined): string | null {
  return context ? JSON.stringify(context) : null;
}

function dataSliceJson(dataSlice: DataSlice | undefined): string | null {
  if (!dataSlice) {
    return null;
  }

  if (
    !Number.isSafeInteger(dataSlice.offset) ||
    dataSlice.offset < 0 ||
    !Number.isSafeInteger(dataSlice.length) ||
    dataSlice.length < 0
  ) {
    throw new InvalidAccountDataError(
      "dataSlice offset and length must be non-negative safe integers"
    );
  }

  return JSON.stringify({
    offset: dataSlice.offset,
    length: dataSlice.length
  });
}

function buildJsonParsedFallback(
  account: NormalizedAccountInput,
  dataSlice: DataSlice | undefined
): UiAccount {
  return {
    lamports: toUiNumber(account.lamports),
    data: [sliceBytes(account.dataBytes, dataSlice).toString("base64"), "base64"],
    owner: account.owner,
    executable: account.executable,
    rentEpoch: toUiNumber(account.rentEpoch),
    space: account.dataBytes.length
  };
}

function sliceBytes(data: Buffer, dataSlice: DataSlice | undefined): Buffer {
  if (!dataSlice) {
    return data;
  }

  const end =
    dataSlice.length > Number.MAX_SAFE_INTEGER - dataSlice.offset
      ? Number.MAX_SAFE_INTEGER
      : dataSlice.offset + dataSlice.length;
  return data.subarray(dataSlice.offset, end);
}

function normalizeEncoding(encoding: AccountDataEncoding): AccountDataEncoding {
  switch (encoding) {
    case "binary":
    case "base58":
    case "base64":
    case "base64+zstd":
    case "jsonParsed":
      return encoding;
    default:
      throw new UnsupportedEncodingError(
        `unsupported account encoding '${String(encoding)}'`,
        { encoding }
      );
  }
}

function toWasmEncoding(encoding: AccountDataEncoding): WasmUiAccountEncoding {
  switch (encoding) {
    case "binary":
      return WasmUiAccountEncoding.Binary;
    case "base58":
      return WasmUiAccountEncoding.Base58;
    case "base64":
      return WasmUiAccountEncoding.Base64;
    case "base64+zstd":
      return WasmUiAccountEncoding.Base64Zstd;
    case "jsonParsed":
      return WasmUiAccountEncoding.JsonParsed;
  }
}

function mapWasmError(
  error: unknown,
  metadata: AccountEncodingErrorMetadata
): Error {
  if (
    error instanceof UnsupportedEncodingError ||
    error instanceof InvalidAccountDataError ||
    error instanceof MissingParseContextError ||
    error instanceof ContextFetchError ||
    error instanceof WasmParserError
  ) {
    return error;
  }

  const payload = parseWasmErrorPayload(error);
  const message = payload?.message ?? errorMessage(error);
  const common = {
    pubkey: payload?.pubkey ?? metadata.pubkey,
    owner: payload?.owner ?? metadata.owner,
    encoding: payload?.encoding ?? metadata.encoding,
    cause: error
  };

  switch (payload?.code) {
    case "INVALID_ACCOUNT_DATA":
      return new InvalidAccountDataError(message, common);
    case "MISSING_PARSE_CONTEXT":
      return new MissingParseContextError(message, {
        ...common,
        missingAccounts: payload.missingContext?.missingAccounts ?? [],
        contextKind: payload.missingContext?.contextKind
      });
    case "WASM_PARSER_ERROR":
      return new WasmParserError(message, common);
    default:
      return new WasmParserError(message, common);
  }
}

function parseWasmErrorPayload(error: unknown): WasmErrorPayload | undefined {
  const message = errorMessage(error);
  try {
    const parsed = JSON.parse(message) as WasmErrorPayload;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseWasmJson<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (cause) {
    throw new WasmParserError("WASM returned invalid JSON", { cause });
  }
}

function toWeb3JsParsedAccountData(
  data: EncodedAccountData,
  metadata: AccountEncodingErrorMetadata
): Buffer | ParsedAccountData {
  if (Array.isArray(data)) {
    const [value, encoding] = data;
    if (encoding !== "base64") {
      throw new UnsupportedEncodingError(
        `cannot convert ${encoding} account data into web3.js parsed AccountInfo`,
        metadata
      );
    }
    return Buffer.from(value, "base64");
  }

  if (typeof data === "string") {
    throw new UnsupportedEncodingError(
      "cannot convert legacy string account data into web3.js parsed AccountInfo",
      metadata
    );
  }

  return data;
}

function toBuffer(value: Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function normalizePubkey(pubkey: string | PublicKey): string {
  if (typeof pubkey === "string") {
    return new PublicKey(pubkey).toBase58();
  }

  return pubkey.toBase58();
}

function normalizePubkeyOrThrow(
  pubkey: string | PublicKey,
  fieldName: string,
  metadata: AccountEncodingErrorMetadata
): string {
  try {
    return normalizePubkey(pubkey);
  } catch (cause) {
    throw new InvalidAccountDataError(`invalid ${fieldName}`, {
      ...metadata,
      cause
    });
  }
}

function toU64String(
  value: number | bigint | string,
  fieldName: string,
  metadata: AccountEncodingErrorMetadata
): string {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidAccountDataError(
        `${fieldName} must be a safe integer when provided as a number`,
        metadata
      );
    }
    parsed = BigInt(value);
  } else {
    if (!/^\d+$/.test(value)) {
      throw new InvalidAccountDataError(`${fieldName} must be an unsigned integer`, {
        ...metadata,
        cause: value
      });
    }
    parsed = BigInt(value);
  }

  if (parsed < 0n || parsed > U64_MAX) {
    throw new InvalidAccountDataError(`${fieldName} must fit in u64`, metadata);
  }

  return parsed.toString();
}

function toUiNumber(value: string): number {
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE_BIGINT) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Number(parsed);
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
