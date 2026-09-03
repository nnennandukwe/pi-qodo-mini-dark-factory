import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCommand } from "../src/process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CLI rejects a misspelled safety-sensitive option", async () => {
  const result = await runCommand(
    [process.execPath, "src/cli.mjs", "retry-review", "--qodo-dept", "deep"],
    { cwd: root },
  );
  assert.equal(result.exit_code, 1);
  assert.match(result.stderr, /Unknown option for retry-review: --qodo-dept/);
});

test("CLI help documents review retry and recovery input", async () => {
  const result = await runCommand([process.execPath, "src/cli.mjs", "--help"], { cwd: root });
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /retry-review --run-dir/);
  assert.match(result.stdout, /--attempt-id/);
});

test("CLI help documents the benchmark and resume path", async () => {
  const result = await runCommand([process.execPath, "src/cli.mjs", "--help"], { cwd: root });
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /benchmark --provider/);
  assert.match(result.stdout, /--resume/);
});
