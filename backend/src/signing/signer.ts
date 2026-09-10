export interface Signer {
  deriveAddress(index: number): string;

  signHash(index: number, hash: Uint8Array): Uint8Array;
}
