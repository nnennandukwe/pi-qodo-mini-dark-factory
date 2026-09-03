import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(process.argv[2] ?? ".");
const moduleUrl = pathToFileURL(path.join(repo, "src", "session.ts")).href;
const { renewSession } = await import(moduleUrl);

assert.deepEqual(
  renewSession({ subject: "oracle-user", expiresAt: 100 }, 101),
  { status: 401, body: { error: "invalid_token" } },
  "a token strictly older than now must be rejected",
);
assert.deepEqual(
  renewSession({ subject: "oracle-user", expiresAt: 100 }, 100),
  { status: 401, body: { error: "invalid_token" } },
  "a token expiring exactly now must be rejected",
);
assert.equal(
  renewSession({ subject: "oracle-user", expiresAt: 101 }, 100).status,
  200,
  "a future token must still renew",
);

process.stdout.write("held-out expiration oracle passed\n");
