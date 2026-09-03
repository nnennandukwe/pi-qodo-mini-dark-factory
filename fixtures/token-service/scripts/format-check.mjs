import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(fullPath)));
    else if ([".ts", ".mjs", ".json"].includes(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

const failures = [];
for (const file of await filesUnder(process.cwd())) {
  const text = await readFile(file, "utf8");
  if (!text.endsWith("\n")) failures.push(`${path.relative(process.cwd(), file)} needs a final newline`);
  if (text.split("\n").some((line) => /[ \t]+$/.test(line))) {
    failures.push(`${path.relative(process.cwd(), file)} contains trailing whitespace`);
  }
}
if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("format check passed\n");
}
