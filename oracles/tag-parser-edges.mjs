import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(process.argv[2] ?? ".");
const moduleUrl = pathToFileURL(path.join(repo, "src", "tags.ts")).href;
const { parseTags } = await import(moduleUrl);

assert.deepEqual(
  parseTags("api, ,security,api,,typescript, security"),
  ["api", "security", "typescript"],
  "empty segments must be ignored and duplicates must retain first-seen order",
);
assert.deepEqual(parseTags(" , , "), [], "whitespace-only segments must produce no tags");

process.stdout.write("held-out tag parser oracle passed\n");
