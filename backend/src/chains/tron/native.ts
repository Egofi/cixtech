import type { ChainDeposit } from "@/types";
import { z } from "zod";

import { tronAddressFromHex } from "./address.js";

const TransferContractValue = z.object({
  owner_address: z.string(),
  to_address: z.string(),
  amount: z.number().int().nonnegative(),
});

const NativeTx = z.object({
  txID: z.string().min(1),
  raw_data: z.object({
    contract: z
      .array(z.object({ type: z.string(), parameter: z.object({ value: z.unknown() }) }))
      .min(1),
  }),
  ret: z.array(z.object({ contractRet: z.string() })).optional(),
});

const NativeResponse = z.object({ data: z.array(NativeTx) });

export function parseNativeTransfers(raw: unknown): ChainDeposit[] {
  const { data } = NativeResponse.parse(raw);
  const deposits: ChainDeposit[] = [];
  for (const tx of data) {
    const contract = tx.raw_data.contract[0];
    if (!contract || contract.type !== "TransferContract") continue;
    if (tx.ret?.[0]?.contractRet !== "SUCCESS") continue;

    const value = TransferContractValue.parse(contract.parameter.value);
    deposits.push({
      chain: "TRON",
      txId: tx.txID,
      index: 0,
      to: tronAddressFromHex(value.to_address),
      from: tronAddressFromHex(value.owner_address),
      asset: "TRX",
      amountBaseUnits: BigInt(value.amount),
    });
  }
  return deposits;
}
