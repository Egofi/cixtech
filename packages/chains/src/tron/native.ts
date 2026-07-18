import { z } from "zod";
import type { ChainDeposit } from "../chain-adapter.js";
import { tronAddressFromHex } from "./address.js";

/**
 * Native TRX transfers from TronGrid `/v1/accounts/{address}/transactions`,
 * validated at the boundary. Only `TransferContract` rows that succeeded
 * (`contractRet === "SUCCESS"`) become deposits — a reverted transfer must never
 * credit. Addresses arrive hex-encoded; amounts are in SUN (1 TRX = 1e6 SUN).
 *
 * NOTE: TronGrid returns native `amount` as a JSON number. TRX amounts on
 * testnet stay well within safe-integer range; TRC20 uses an exact string value.
 */
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
    if (tx.ret?.[0]?.contractRet !== "SUCCESS") continue; // reverted transfers never credit

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
