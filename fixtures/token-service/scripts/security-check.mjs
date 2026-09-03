import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(fullPath)));
    else if (entry.name.endsWith(".ts")) files.push(fullPath);
  }
  return files;
}

const banned = ["eval(", "node:child_process", "BEGIN PRIVATE KEY"];
const findings = [];
for (const file of await sourceFiles(path.join(process.cwd(), "src"))) {
  const text = await readFile(file, "utf8");
  for (const pattern of banned) {
    if (text.includes(pattern)) findings.push(`${path.relative(process.cwd(), file)} contains ${pattern}`);
  }
}
if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("security check passed\n");
}
