/* global process */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const buildDirectory = resolve(".scaffold/build");
const files = await findReleaseArtifacts(buildDirectory);
if (files.length === 0) {
  throw new Error(`No release artifacts found under ${buildDirectory}`);
}

const lines = [];
for (const file of files.sort()) {
  const digest = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  lines.push(
    `${digest}  ${relative(buildDirectory, file).replaceAll("\\", "/")}`,
  );
}

const outputPath = join(buildDirectory, "SHA256SUMS.txt");
await writeFile(outputPath, `${lines.join("\n")}\n`, {
  encoding: "utf8",
  flag: "w",
});
process.stdout.write(`Wrote ${outputPath}\n${lines.join("\n")}\n`);

async function findReleaseArtifacts(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findReleaseArtifacts(path)));
    } else if (
      entry.isFile() &&
      entry.name !== "SHA256SUMS.txt" &&
      (entry.name.toLowerCase().endsWith(".xpi") ||
        entry.name.toLowerCase().endsWith(".json"))
    ) {
      results.push(path);
    }
  }
  return results;
}
