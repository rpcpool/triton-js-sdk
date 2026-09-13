import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { normalizeAccountId, normalizeAccountIds } from "../src/connection/utils";

describe("account id validation", () => {
  it("normalizes valid account ids and removes duplicates", () => {
    const account = new PublicKey(
      "ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989"
    );
    const normalized = normalizeAccountIds([account.toBase58(), account]);
    expect(normalized).toEqual([account.toBase58()]);
  });

  it("normalizes public key-like objects without requiring instanceof PublicKey", () => {
    const accountId = "ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989";
    const publicKeyLike = {
      toBase58: () => accountId
    } as unknown as PublicKey;

    expect(normalizeAccountId(publicKeyLike)).toBe(accountId);
  });

  it("lets public key-like toBase58 errors bubble up", () => {
    const expectedError = new Error("toBase58 failed");
    const publicKeyLike = {
      toBase58: () => {
        throw expectedError;
      }
    } as unknown as PublicKey;

    expect(() => normalizeAccountId(publicKeyLike)).toThrow(expectedError);
  });

  it("throws web3.js PublicKey validation errors for empty account id", () => {
    const invalidAccountId = "   ";
    const expectedError = capturePublicKeyError(invalidAccountId);

    expect(() => normalizeAccountId(invalidAccountId)).toThrow(
      expectedError.message
    );
  });

  it("throws web3.js PublicKey validation errors for invalid base58 account id", () => {
    const invalidAccountId = "7QxF2d9oR8kP5z7w3t6y8u9i0o1p2a3s4d5f6g7h8j9k";
    const expectedError = capturePublicKeyError(invalidAccountId);

    expect(() =>
      normalizeAccountId(invalidAccountId)
    ).toThrow(expectedError.message);
  });
});

function capturePublicKeyError(accountId: string): Error {
  try {
    new PublicKey(accountId);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }

  throw new Error("expected PublicKey constructor to reject invalid account id");
}
