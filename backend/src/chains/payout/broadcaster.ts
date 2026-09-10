import type { AuthorizationToken, BroadcastResult, PayoutRequest } from "@/types";

export interface PayoutBroadcaster {
  send(req: PayoutRequest): Promise<BroadcastResult>;
}
