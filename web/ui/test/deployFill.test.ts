import { describe, expect, it } from "vitest";
import { followAmount } from "../src/ox/deployFill";

describe("deploy form: the other side at the market rate", () => {
  it("tokens → sats = tokens × price, whole sats rounded", () => {
    expect(followAmount("tokens", "1000", 1, 5)).toBe("1000");
    expect(followAmount("tokens", "3", 2.5, 0)).toBe("8"); // 7.5 → 8
    expect(followAmount("tokens", "1.23456", 100, 5)).toBe("123"); // 123.456 → 123
    expect(followAmount("tokens", "1,000", 0.995, 2)).toBe("995");
  });

  it("sats → tokens = sats ÷ price in the token's decimals", () => {
    expect(followAmount("sats", "1000", 1, 5)).toBe("1000");
    expect(followAmount("sats", "100", 3, 5)).toBe("33.33333");
    expect(followAmount("sats", "200", 3, 5)).toBe("66.66667"); // rounded at the last place
    expect(followAmount("sats", "10", 4, 0)).toBe("3"); // 2.5 → 3, whole tokens for dec 0
    expect(followAmount("sats", "5", 2, 2)).toBe("2.5");
  });

  it("no market price: nothing follows", () => {
    expect(followAmount("tokens", "1000", null, 5)).toBeNull();
    expect(followAmount("sats", "1000", null, 5)).toBeNull();
    expect(followAmount("sats", "1000", 0, 5)).toBeNull();
    expect(followAmount("sats", "1000", Number.NaN, 5)).toBeNull();
  });

  it("an empty or unparseable source empties the other", () => {
    expect(followAmount("tokens", "", 1, 5)).toBe("");
    expect(followAmount("tokens", "abc", 1, 5)).toBe("");
    expect(followAmount("tokens", "1.123", 1, 2)).toBe(""); // more places than the token has
    expect(followAmount("sats", "1.5", 1, 2)).toBe(""); // sats are whole
  });

  it("source switch: each direction derives from what was typed, and round-trips at the market", () => {
    const price = 1.25;
    const sats = followAmount("tokens", "80", price, 2)!;
    expect(sats).toBe("100");
    // now the user types in Sats: Tokens follows from it
    expect(followAmount("sats", "250", price, 2)).toBe("200");
    expect(followAmount("sats", sats, price, 2)).toBe("80");
  });

  it("a different token's decimals re-derive from the same source text", () => {
    expect(followAmount("sats", "100", 3, 0)).toBe("33");
    expect(followAmount("sats", "100", 3, 8)).toBe("33.33333333");
  });
});
