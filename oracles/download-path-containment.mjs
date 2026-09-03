import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(process.argv[2] ?? ".");
const moduleUrl = pathToFileURL(path.join(repo, "src", "files.ts")).href;
const { resolveDownloadPath } = await import(moduleUrl);

const root = path.resolve("/srv/downloads");
assert.equal(
  resolveDownloadPath(root, "../downloads-private/secrets.txt"),
  null,
  "a sibling directory sharing the root prefix must not pass containment",
);
assert.equal(
  resolveDownloadPath(root, "reports/weekly.pdf"),
  path.join(root, "reports", "weekly.pdf"),
  "a nested file inside the root must remain accessible",
);

process.stdout.write("held-out download path oracle passed\n");
