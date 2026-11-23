import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/config/env.js";

const base = {
  DATABASE_URL: "postgres://x",
  JWT_SECRET: "a".repeat(40),
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("environment configuration", () => {
  it("treats empty optional variables as unset (Railway references to unset variables)", () => {
    const r = parseEnv({ ...base, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_CA_CERT: "", WEB_ORIGIN: "" });
    expect(r.success).toBe(true);
    expect(r.data?.SUPABASE_URL).toBeUndefined();
    expect(r.data?.WEB_ORIGIN).toBe("http://localhost:3100");
  });

  it("still rejects missing required and malformed values", () => {
    expect(parseEnv({ ...base, DATABASE_URL: "" }).success).toBe(false);
    expect(parseEnv({ ...base, SUPABASE_URL: "not a url" }).success).toBe(false);
    expect(parseEnv({ ...base, CREDENTIALS_ENCRYPTION_KEY: "short" }).success).toBe(false);
  });
});
