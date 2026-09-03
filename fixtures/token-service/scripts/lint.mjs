import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(fullPath)));
    else if (entry.name.endsWith(".ts")) files.push(fullPath);
  }
  return files;
}

const problems = [];
for (const file of await sourceFiles(process.cwd())) {
  const text = await readFile(file, "utf8");
  if (text.includes("\t")) problems.push(`${path.relative(process.cwd(), file)} contains a tab`);
  if (/\bany\b/.test(text)) problems.push(`${path.relative(process.cwd(), file)} uses any`);
}
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("lint passed\n");
}
