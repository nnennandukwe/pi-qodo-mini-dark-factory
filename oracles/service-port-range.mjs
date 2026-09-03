import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(process.argv[2] ?? ".");
const moduleUrl = pathToFileURL(path.join(repo, "src", "config.ts")).href;
const { parseServicePort } = await import(moduleUrl);

assert.equal(parseServicePort("1"), 1, "the lowest valid TCP port must be accepted");
assert.equal(parseServicePort("65535"), 65535, "the highest valid TCP port must be accepted");
assert.equal(parseServicePort("0"), null, "port zero must be rejected");
assert.equal(parseServicePort("-1"), null, "negative ports must be rejected");
assert.equal(parseServicePort("65536"), null, "ports above 65535 must be rejected");
assert.equal(parseServicePort(""), null, "an empty value must be rejected");

process.stdout.write("held-out service port oracle passed\n");
