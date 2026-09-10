export interface Share {
  x: bigint;
  y: bigint;
}

export interface DealerlessResult {
  shares: KeyShare[];
  publicKey: Uint8Array;
  commitments: Uint8Array[];
}

export interface SigningContext {
  index: number;
  hash: Uint8Array;
}

export interface KeyShare {
  nodeId: number;
  share: Share;
  publicKey: Uint8Array;
  threshold: number;
  epoch: number;
}

export interface ThresholdSignerOptions {
  commitments?: Uint8Array[];
  acknowledgeInterim?: boolean;
  production?: boolean;
}
