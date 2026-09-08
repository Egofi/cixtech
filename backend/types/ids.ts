import type { Brand } from "./brand.js";

export type TenantId = Brand<string, "TenantId">;
export type AccountId = Brand<string, "AccountId">;
export type MerchantRef = Brand<string, "MerchantRef">;
export type JournalEntryId = Brand<string, "JournalEntryId">;

/**
 * Idempotency key for a journal entry. On-chain events use `(chain, txHash, index)`;
 * engine-initiated intents use `intentId`. Re-posting the same key is a no-op.
 */
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

export const TenantId = (s: string): TenantId => s as TenantId;
export const AccountId = (s: string): AccountId => s as AccountId;
export const MerchantRef = (s: string): MerchantRef => s as MerchantRef;
export const JournalEntryId = (s: string): JournalEntryId => s as JournalEntryId;
export const IdempotencyKey = (s: string): IdempotencyKey => s as IdempotencyKey;
