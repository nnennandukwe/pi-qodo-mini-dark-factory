import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(process.argv[2] ?? ".");
const sourcePath = path.join(repo, "src", "identity.ts");
const moduleUrl = pathToFileURL(sourcePath).href;
const { canonicalizeLoginEmail, canonicalizeRecoveryEmail } = await import(moduleUrl);

for (const canonicalize of [canonicalizeLoginEmail, canonicalizeRecoveryEmail]) {
  assert.equal(canonicalize("  User+Alias@Example.COM  "), "user+alias@example.com");
  assert.equal(canonicalize("already@example.com"), "already@example.com");
}

const source = await readFile(sourcePath, "utf8");
const normalizationExpressions = source.match(/\.trim\(\)\.toLowerCase\(\)/g) ?? [];
assert.equal(
  normalizationExpressions.length,
  1,
  "the trim-and-lowercase normalization expression must have one implementation",
);

process.stdout.write("held-out email refactor oracle passed\n");
