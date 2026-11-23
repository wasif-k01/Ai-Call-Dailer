// Test environment: isolated database, throwaway secrets. No real provider calls.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/acp_test";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-123456";
process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.ALLOW_SIGNUP = "true";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15";
process.env.RUN_MIGRATIONS_ON_START = "false";
