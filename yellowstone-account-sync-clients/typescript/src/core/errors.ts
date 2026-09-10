import type { AccountSyncCommitment } from "./types";

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
 *
 * This can happen when an account has not yet been observed, or when its latest
 * observation is older than the requested `minContextSlot`.
 */
export class AccountSyncReadTimeoutError extends Error {
  /** Base58 address of the account being read. */
  public readonly accountId: string;
  /** Commitment buffer used for the read. */
  public readonly commitment: AccountSyncCommitment;
  /** Time the read waited, in milliseconds. */
  public readonly timeoutMs: number;
  /** Minimum context slot requested by the caller, when set. */
  public readonly minContextSlot?: number;

  /**
   * Creates an error for a buffered read that reached its time limit.
   *
   * @param options Account address, commitment, and read constraints.
   */
  constructor(options: AccountSyncReadTimeoutErrorOptions) {
    const minimum =
      options.minContextSlot === undefined
        ? ""
        : ` at or after context slot ${options.minContextSlot}`;
    super(
      `failed to get info about account ${options.accountId}${minimum}: ` +
        `account-sync read timed out after ${options.timeoutMs}ms`
    );
    this.name = "AccountSyncReadTimeoutError";
    this.accountId = options.accountId;
    this.commitment = options.commitment;
    this.timeoutMs = options.timeoutMs;
    this.minContextSlot = options.minContextSlot;
  }
}
