import type { ChainDeposit } from "@/types";
import { z } from "zod";

const Trc20Tx = z.object({
  transaction_id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.string(),
  value: z.string().regex(/^\d+$/),
  token_info: z.object({
    symbol: z.string().min(1),
    address: z.string().min(1),
    decimals: z.number().int().nonnegative(),
  }),
  block_timestamp: z.number().optional(),
});

const Trc20Response = z.object({ data: z.array(Trc20Tx) });

export type Trc20Tx = z.infer<typeof Trc20Tx>;

export function toDeposit(tx: Trc20Tx): ChainDeposit | null {
  if (tx.type !== "Transfer") return null;
  return {
    chain: "TRON",
    txId: tx.transaction_id,
    index: 0,
    to: tx.to,
    from: tx.from,
    asset: tx.token_info.symbol.toUpperCase(),
    tokenContract: tx.token_info.address,
    amountBaseUnits: BigInt(tx.value),
  };
}

export function parseTrc20Response(raw: unknown): ChainDeposit[] {
  const { data } = Trc20Response.parse(raw);
  return data.map(toDeposit).filter((d): d is ChainDeposit => d !== null);
}
