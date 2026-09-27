import assert from "node:assert/strict";
import { scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

test("router bootstrap seeds admin/admin as a forced password change", () => {
  const sql = readFileSync(new URL("../../router-edition/database/init.sql", import.meta.url), "utf8");
  const match = sql.match(
    /INSERT OR IGNORE INTO auth_users\s*\(id, username, passwordHash, passwordSalt, mustChangePassword\)\s*VALUES\s*\(1, '([^']+)', '([0-9a-f]+)', '([0-9a-f]+)', 1\)/,
  );
  assert.ok(match, "router database seed must contain the bootstrap admin");
  const [, username, passwordHash, passwordSalt] = match;
  assert.equal(username, "admin");

  const actual = scryptSync("admin", Buffer.from(passwordSalt, "hex"), 32);
  const expected = Buffer.from(passwordHash, "hex");
  assert.equal(expected.length, actual.length);
  assert.equal(timingSafeEqual(actual, expected), true);
});
