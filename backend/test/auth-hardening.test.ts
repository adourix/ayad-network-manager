import assert from "node:assert/strict";
import test from "node:test";

test("production authentication rejects the legacy default password configuration", async () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    password: process.env.ADMIN_PASSWORD,
    hash: process.env.ADMIN_PASSWORD_HASH,
    salt: process.env.ADMIN_PASSWORD_SALT,
    databaseUrl: process.env.DATABASE_URL,
  };

  process.env.NODE_ENV = "production";
  process.env.ADMIN_PASSWORD = "change-me-before-production";
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_PASSWORD_SALT;
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

  try {
    const auth = await import("../src/interfaces/http/auth.js");
    assert.equal(typeof auth.registerAuthentication, "function");
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.password === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous.password;
    if (previous.hash === undefined) delete process.env.ADMIN_PASSWORD_HASH;
    else process.env.ADMIN_PASSWORD_HASH = previous.hash;
    if (previous.salt === undefined) delete process.env.ADMIN_PASSWORD_SALT;
    else process.env.ADMIN_PASSWORD_SALT = previous.salt;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
  }
});
