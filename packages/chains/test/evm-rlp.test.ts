import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import { rlpEncode } from "../src/evm/rlp.js";

const hex = (i: Parameters<typeof rlpEncode>[0]) => bytesToHex(rlpEncode(i));

describe("RLP encoding (canonical vectors)", () => {
  it("encodes byte strings", () => {
    expect(hex(utf8ToBytes("dog"))).toBe("83646f67");
    expect(hex(new Uint8Array(0))).toBe("80");
    expect(hex(Uint8Array.of(0x0f))).toBe("0f"); // single low byte is itself
    expect(hex(Uint8Array.of(0x00))).toBe("00");
    expect(hex(Uint8Array.of(0x80))).toBe("8180"); // 0x80 needs a length prefix
  });

  it("encodes integers minimally (0 → empty string)", () => {
    expect(hex(0n)).toBe("80");
    expect(hex(15n)).toBe("0f");
    expect(hex(1024n)).toBe("820400");
  });

  it("encodes lists", () => {
    expect(hex([])).toBe("c0");
    expect(hex([utf8ToBytes("cat"), utf8ToBytes("dog")])).toBe("c88363617483646f67");
    expect(hex([[], [[]], [[], [[]]]])).toBe("c7c0c1c0c3c0c1c0"); // nested-list set
  });

  it("length-prefixes strings longer than 55 bytes", () => {
    const long = utf8ToBytes("Lorem ipsum dolor sit amet, consectetur adipisicing elit");
    // 56 bytes → 0xb8 (0xb7+1), then length 0x38, then the bytes ('L' = 0x4c).
    expect(hex(long).slice(0, 6)).toBe("b8384c");
  });
});
