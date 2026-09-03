import assert from "node:assert/strict";
import test from "node:test";

import { renewSession } from "../src/session.ts";

test("renews a valid token", () => {
  assert.deepEqual(
    renewSession({ subject: "user-123", expiresAt: 1_700_000_100 }, 1_700_000_000),
    { status: 200, body: { token: "renewed:user-123:1700000000" } },
  );
});

test("rejects a token without a subject", () => {
  assert.deepEqual(
    renewSession({ subject: "", expiresAt: 1_700_000_100 }, 1_700_000_000),
    { status: 401, body: { error: "invalid_token" } },
  );
});
