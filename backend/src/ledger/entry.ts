import type { Asset, Direction, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";

export const flip = (d: Direction): Direction => (d === "DEBIT" ? "CREDIT" : "DEBIT");
