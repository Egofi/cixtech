import { createHash } from "node:crypto";
import type { HttpClient } from "@/chains/http.js";
import { tronAddressFromPubkey, tronAddressToHex } from "@/chains/index.js";
import { TronPayoutBroadcaster } from "@/chains/payout/tron-broadcaster.js";
import { TronTxMismatchError, decodeTronRawData } from "@/chains/tron/tron-tx-verify.js";
import { KeypairSigner } from "@/signing";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";

// ── Minimal protobuf ENCODER, so the fixtures below are real Tron wire format ──
// The verifier has its own decoder; encoding independently here means a bug in
// one is not silently cancelled out by the same bug in the other.
const varint = (n: bigint): Uint8Array => {
  const out: number[] = [];
  let v = n;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Uint8Array.from(out);
};
const tag = (no: number, wire: number) => varint((BigInt(no) << 3n) | BigInt(wire));
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const lenField = (no: number, payload: Uint8Array) =>
  cat(tag(no, 2), varint(BigInt(payload.length)), payload);
const varField = (no: number, value: bigint) => cat(tag(no, 0), varint(value));
const bytesOf = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

/** TriggerSmartContract{owner, contract, call_value, data} inside Transaction.raw. */
function trc20Raw(ownerHex: string, contractHex: string, calldataHex: string, callValue = 0n) {
  const trigger = cat(
    lenField(1, bytesOf(ownerHex)),
    lenField(2, bytesOf(contractHex)),
    ...(callValue > 0n ? [varField(3, callValue)] : []),
    lenField(4, bytesOf(calldataHex)),
  );
  const any = cat(
    lenField(1, Buffer.from("type.googleapis.com/protocol.TriggerSmartContract")),
    lenField(2, trigger),
  );
  const contractEntry = cat(varField(1, 31n), lenField(2, any));
  return Buffer.from(cat(lenField(1, bytesOf("0000")), lenField(11, contractEntry))).toString(
    "hex",
  );
}

/** TransferContract{owner, to, amount} inside Transaction.raw. */
function trxRaw(ownerHex: string, toHex: string, amount: bigint) {
  const transfer = cat(
    lenField(1, bytesOf(ownerHex)),
    lenField(2, bytesOf(toHex)),
    varField(3, amount),
  );
  const any = cat(
    lenField(1, Buffer.from("type.googleapis.com/protocol.TransferContract")),
    lenField(2, transfer),
  );
  return Buffer.from(
    cat(lenField(1, bytesOf("0000")), lenField(11, cat(varField(1, 1n), lenField(2, any)))),
  ).toString("hex");
}

const calldata = (toHex21: string, amount: bigint) =>
  `a9059cbb${toHex21.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;

const txIdOf = (rawHex: string) =>
  createHash("sha256").update(Buffer.from(rawHex, "hex")).digest("hex");

const XPRV = HDKey.fromMasterSeed(
  Uint8Array.from(Buffer.from("00112233445566778899aabbccddeeff", "hex")),
).derive("m/44'/195'/0'").privateExtendedKey;

const MERCHANT = "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW";
const ATTACKER = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const USDT = "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj";

/** A Tron node under test control — returns whatever `plant` says. */
class ScriptedNode implements HttpClient {
  broadcast: { signature?: string[] } | undefined;
  constructor(private readonly plant: (url: string, body: unknown) => unknown) {}
  async getJson<T>(): Promise<T> {
    throw new Error("unused");
  }
  async postJson<T>(url: string, body: unknown): Promise<T> {
    if (url.endsWith("/wallet/broadcasttransaction")) {
      this.broadcast = body as { signature?: string[] };
      return { result: true } as T;
    }
    return this.plant(url, body) as T;
  }
}

function broadcaster(node: HttpClient) {
  const signer = new KeypairSigner(XPRV, tronAddressFromPubkey);
  return {
    signer,
    from: signer.deriveAddress(0),
    b: new TronPayoutBroadcaster(node, signer, {
      baseUrl: "https://node.example",
      tokenContracts: { USDT },
    }),
  };
}

const trc20Req = (from: string) => ({
  chain: "TRON",
  asset: "USDT",
  amountBaseUnits: 1_000_000n,
  toAddress: MERCHANT,
  fromAddress: from,
  fromDerivationIndex: 0,
  idempotencyKey: "k1",
});

describe("Tron transaction verification before signing", () => {
  it("signs a transaction that genuinely matches the payout", async () => {
    const from = new KeypairSigner(XPRV, tronAddressFromPubkey).deriveAddress(0);
    const raw = trc20Raw(
      tronAddressToHex(from),
      tronAddressToHex(USDT),
      calldata(tronAddressToHex(MERCHANT), 1_000_000n),
    );
    const node = new ScriptedNode(() => ({
      result: { result: true },
      transaction: { txID: txIdOf(raw), raw_data_hex: raw },
    }));
    const { b } = broadcaster(node);

    const res = await b.send(trc20Req(from) as never);
    expect(res.txId).toBe(txIdOf(raw));
    // 65-byte r‖s‖v, hex — the honest path still signs and broadcasts.
    expect(node.broadcast?.signature?.[0]).toMatch(/^[0-9a-f]{130}$/);
  });

  it("REFUSES a substituted destination — the original attack", async () => {
    const { from, b } = broadcaster(
      new ScriptedNode(() => {
        // Node was asked for 1 USDT to MERCHANT; it builds a drain to ATTACKER.
        const raw = trc20Raw(
          tronAddressToHex(from),
          tronAddressToHex(USDT),
          calldata(tronAddressToHex(ATTACKER), 999_999_999_999n),
        );
        return { result: { result: true }, transaction: { txID: txIdOf(raw), raw_data_hex: raw } };
      }),
    );
    await expect(b.send(trc20Req(from) as never)).rejects.toThrow(TronTxMismatchError);
  });

  it("REFUSES a substituted amount", async () => {
    const { from, b } = broadcaster(
      new ScriptedNode(() => {
        const raw = trc20Raw(
          tronAddressToHex(from),
          tronAddressToHex(USDT),
          calldata(tronAddressToHex(MERCHANT), 500_000_000n),
        );
        return { result: { result: true }, transaction: { txID: txIdOf(raw), raw_data_hex: raw } };
      }),
    );
    await expect(b.send(trc20Req(from) as never)).rejects.toThrow(/amount/i);
  });

  it("REFUSES a substituted token contract", async () => {
    const { from, b } = broadcaster(
      new ScriptedNode(() => {
        const raw = trc20Raw(
          tronAddressToHex(from),
          tronAddressToHex(ATTACKER), // some other token
          calldata(tronAddressToHex(MERCHANT), 1_000_000n),
        );
        return { result: { result: true }, transaction: { txID: txIdOf(raw), raw_data_hex: raw } };
      }),
    );
    await expect(b.send(trc20Req(from) as never)).rejects.toThrow(/token contract/i);
  });

  it("REFUSES a txID that is not the hash of the returned body", async () => {
    const { from, b } = broadcaster(
      new ScriptedNode(() => {
        // Honest-looking body, but the txID commits to something else entirely.
        const raw = trc20Raw(
          tronAddressToHex(from),
          tronAddressToHex(USDT),
          calldata(tronAddressToHex(MERCHANT), 1_000_000n),
        );
        return {
          result: { result: true },
          transaction: { txID: "ab".repeat(32), raw_data_hex: raw },
        };
      }),
    );
    await expect(b.send(trc20Req(from) as never)).rejects.toThrow(/not the hash/i);
  });

  it("REFUSES a body with no raw_data_hex to check at all", async () => {
    const { from, b } = broadcaster(
      new ScriptedNode(() => ({
        result: { result: true },
        transaction: { txID: "cd".repeat(32) },
      })),
    );
    await expect(b.send(trc20Req(from) as never)).rejects.toThrow(TronTxMismatchError);
  });

  it("REFUSES a TRC20 call that smuggles native TRX out via call_value", async () => {
    const { from, b } = broadcaster(
      new ScriptedNode(() => {
        const raw = trc20Raw(
          tronAddressToHex(from),
          tronAddressToHex(USDT),
          calldata(tronAddressToHex(MERCHANT), 1_000_000n),
          50_000_000_000n,
        );
        return { result: { result: true }, transaction: { txID: txIdOf(raw), raw_data_hex: raw } };
      }),
    );
    await expect(b.send(trc20Req(from) as never)).rejects.toThrow(/call_value/i);
  });

  it("REFUSES a non-transfer method with the right selector prefix but extra args", async () => {
    const { from, b } = broadcaster(
      new ScriptedNode(() => {
        const raw = trc20Raw(
          tronAddressToHex(from),
          tronAddressToHex(USDT),
          `${calldata(tronAddressToHex(MERCHANT), 1_000_000n)}${"00".repeat(32)}`,
        );
        return { result: { result: true }, transaction: { txID: txIdOf(raw), raw_data_hex: raw } };
      }),
    );
    await expect(b.send(trc20Req(from) as never)).rejects.toThrow(/plain TRC20 transfer/i);
  });

  it("verifies a native TRX transfer the same way", async () => {
    const { from, b } = broadcaster(
      new ScriptedNode(() => {
        const raw = trxRaw(tronAddressToHex(from), tronAddressToHex(ATTACKER), 5n);
        return { txID: txIdOf(raw), raw_data_hex: raw };
      }),
    );
    await expect(
      b.send({ ...trc20Req(from), asset: "TRX", amountBaseUnits: 5n } as never),
    ).rejects.toThrow(/destination/i);
  });

  it("decodes a well-formed body back to the transfer it describes", () => {
    const raw = trxRaw(tronAddressToHex(MERCHANT), tronAddressToHex(ATTACKER), 42n);
    const got = decodeTronRawData(raw);
    expect(got.ownerHex).toBe(tronAddressToHex(MERCHANT));
    expect(got.toHex).toBe(tronAddressToHex(ATTACKER));
    expect(got.amount).toBe(42n);
  });
});
