import type { AttributionEntry } from "@/types";
export interface Attribution {
  resolve(chain: string, address: string): Promise<AttributionEntry | null>;
}
