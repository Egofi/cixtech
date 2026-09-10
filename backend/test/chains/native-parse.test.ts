import { tronAddressFromHex } from "@/chains/tron/address.js";
import { parseNativeTransfers } from "@/chains/tron/native.js";
import { describe, expect, it } from "vitest";

const FAUCET_TX = {
  data: [
    {
      txID: "c127abc4791d198bb12f3ef077ddd942a85138a360a233f13cd9dd5bd4d5b0c9",
      raw_data: {
        contract: [
          {
            type: "TransferContract",
            parameter: {
              value: {
                owner_address: "41d3682962027e721c5247a9faf7865fe4a71d5438",
                to_address: "416068e61a64410617446c09f76e23358fe95f3b3e",
                amount: 2_000_000_000,
              },
            },
          },
        ],
      },
      ret: [{ contractRet: "SUCCESS" }],
    },
  ],
};

describe("native TRX transfer parsing", () => {
  it("decodes the real to_address hex to the funded base58 address", () => {
    expect(tronAddressFromHex("416068e61a64410617446c09f76e23358fe95f3b3e")).toBe(
      "TJkyXySVnHjqo6VDoRNxUoCh524ViKuv5h",
    );
  });

  it("parses a successful TransferContract into a TRX ChainDeposit", () => {
    const [d] = parseNativeTransfers(FAUCET_TX);
    expect(d).toMatchObject({
      chain: "TRON",
      asset: "TRX",
      to: "TJkyXySVnHjqo6VDoRNxUoCh524ViKuv5h",
      amountBaseUnits: 2_000_000_000n,
    });
  });

  it("skips reverted transfers (contractRet != SUCCESS)", () => {
    const reverted = structuredClone(FAUCET_TX);
    reverted.data[0].ret[0].contractRet = "REVERT";
    expect(parseNativeTransfers(reverted)).toHaveLength(0);
  });

  it("skips non-transfer contracts", () => {
    const other = structuredClone(FAUCET_TX);
    other.data[0].raw_data.contract[0].type = "TriggerSmartContract";
    expect(parseNativeTransfers(other)).toHaveLength(0);
  });
});
