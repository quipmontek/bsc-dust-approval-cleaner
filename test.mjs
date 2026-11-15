// Self-test for the pure helpers in cleaner.mjs.
// No network, no wallet, no transaction. Run: node test.mjs
import assert from "node:assert";
import { pad32, revokeCalldata, formatAmount, decodeUint, decodeString, isAddress } from "./cleaner.mjs";

// pad32: left-pad an address to 32 bytes.
assert.strictEqual(
  pad32("0x10ED43C718714eb63d5aA57B78B54704E256024E"),
  "00000000000000000000000010ed43c718714eb63d5aa57b78b54704e256024e",
);

// revokeCalldata: approve(spender, 0).
// 0x095ea7b3 is the approve(address,uint256) selector.
const router = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
assert.strictEqual(
  revokeCalldata(router),
  "0x095ea7b3" +
    "00000000000000000000000010ed43c718714eb63d5aa57b78b54704e256024e" +
    "0000000000000000000000000000000000000000000000000000000000000000",
);

// formatAmount: raw units -> human units.
assert.strictEqual(formatAmount("1000000000000000000", 18), "1");
assert.strictEqual(formatAmount("13000019290123456790", 18), "13.00001929012345679");
assert.strictEqual(formatAmount("0", 18), "0");
assert.strictEqual(formatAmount("5000000", 6), "5");
assert.strictEqual(formatAmount("123", 0), "123");

// decodeUint: hex -> BigInt.
assert.strictEqual(decodeUint("0x0"), 0n);
assert.strictEqual(decodeUint("0xff"), 255n);
assert.strictEqual(decodeUint("0x000000000000000000000000000000000000000000000000b46958aad508d116"), 13000019290123456790n);
assert.strictEqual(decodeUint("not hex"), null);

// decodeString: ABI-encoded string (offset + length + bytes).
const hello = Buffer.from("hello");
const abi =
  "0x" +
  "0000000000000000000000000000000000000000000000000000000000000020" +
  "0000000000000000000000000000000000000000000000000000000000000005" +
  hello.toString("hex").padEnd(64, "0");
assert.strictEqual(decodeString(abi), "hello");
assert.strictEqual(decodeString("0x"), null);

// isAddress.
assert.strictEqual(isAddress("0x2259faa64d3B97D1d6889CaeAC719e4C64c23e98"), true);
assert.strictEqual(isAddress("0x2259faa64d3B97D1d6889CaeAC719e4C64c23e9"), false);
assert.strictEqual(isAddress("not an address"), false);

console.log("all helper tests passed");
