import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, maskSecret } from "../src/lib/crypto.js";

describe("credential encryption", () => {
  it("round-trips and never stores plaintext", () => {
    const secret = "sk-test-1234567890abcdef";
    const enc = encryptSecret(secret);
    expect(enc.ciphertext).not.toContain("sk-test");
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSecret("same").ciphertext).not.toBe(encryptSecret("same").ciphertext);
  });

  it("detects tampering", () => {
    const enc = encryptSecret("value");
    const tampered = { ...enc, ciphertext: Buffer.from("garbage").toString("base64") };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("masks secrets to the last 4 characters", () => {
    expect(maskSecret("sk-abcdefgh1234")).toBe("••••1234");
  });
});
