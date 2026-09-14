import { describe, expect, it } from "vitest";
import { AccountBuffer } from "../src/core/account_buffer";
import type { DecodedAccountUpdate } from "../src/core/types";

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

describe("AccountBuffer", () => {
  it("keeps newer updates and ignores stale updates", () => {
    const buffer = new AccountBuffer();

    const newer = makeUpdate({ slot: 10n, writeVersion: 5n, lamports: 99n });
    const older = makeUpdate({ slot: 9n, writeVersion: 20n, lamports: 1n });

    expect(buffer.upsert(newer)).toBe(true);
    expect(buffer.upsert(older)).toBe(false);
    expect(buffer.get(newer.accountId)?.lamports).toBe(99n);
  });

  it("resolves waiters when account arrives", async () => {
    const buffer = new AccountBuffer();
    const accountId = "Account2222222222222222222222222222222222";

    const waiter = buffer.waitForAccount(accountId, 2_000);
    buffer.upsert(makeUpdate({ accountId, slot: 12n }));

    const resolved = await waiter;
    expect(resolved.kind).toBe("account");
    if (resolved.kind === "account") {
      expect(resolved.state.slot).toBe(12n);
    }
  });

  it("aborts a pending waiter and removes it from later updates", async () => {
    const buffer = new AccountBuffer();
    const accountId = "Account5555555555555555555555555555555556";
    const controller = new AbortController();
    const waiter = buffer.waitForAccount(
      accountId,
      2_000,
      undefined,
      controller.signal
    );

    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
    expect(buffer.upsert(makeUpdate({ accountId, slot: 20n }))).toBe(true);
  });

  it("stores slot-ordered tombstones for accounts removed by RPC", async () => {
    const buffer = new AccountBuffer();
    const accountId = "Account6666666666666666666666666666666666";
    buffer.upsert(makeUpdate({ accountId, slot: 10n, lamports: 10n }));

    expect(buffer.remove(accountId, 11n)).toBe(true);
    expect(buffer.get(accountId)).toBeNull();
    await expect(buffer.waitForAccount(accountId, 2_000)).resolves.toMatchObject({
      kind: "missing",
      tombstone: { slot: 11n }
    });

    expect(buffer.upsert(makeUpdate({ accountId, slot: 10n }))).toBe(false);
    expect(buffer.upsert(makeUpdate({ accountId, slot: 12n, lamports: 12n }))).toBe(
      true
    );
    expect(buffer.get(accountId)?.lamports).toBe(12n);
  });

  it("deletes account state and tombstones", () => {
    const buffer = new AccountBuffer();
    const stateAccountId = "Account8888888888888888888888888888888888";
    const missingAccountId = "Account9999999999999999999999999999999999";
    buffer.upsert(makeUpdate({ accountId: stateAccountId }));
    buffer.remove(missingAccountId, 12n);

    expect(buffer.delete(stateAccountId)).toBe(true);
    expect(buffer.delete(missingAccountId)).toBe(true);
    expect(buffer.observe(stateAccountId)).toBeNull();
    expect(buffer.observe(missingAccountId)).toBeNull();
    expect(buffer.delete(missingAccountId)).toBe(false);
  });
});
