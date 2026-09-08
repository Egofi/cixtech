import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const filesToUpdate = [
  resolve(repoRoot, ".env"),
  resolve(repoRoot, "apps/api/.env.dev"),
  resolve(repoRoot, "docker.env"),
];

// Generate a 24-byte secure hex token prefixed with cixadmin_
const newToken = `cixadmin_${randomBytes(24).toString("hex")}`;

console.log("\n=======================================================");
console.log("            cixtech Admin API Token Rotation          ");
console.log("=======================================================");
console.log(`New Admin Bearer Token : ${newToken}`);
console.log("=======================================================\n");

let updatedCount = 0;

for (const file of filesToUpdate) {
  if (!existsSync(file)) continue;
  let content = readFileSync(file, "utf8");

  if (/^CIXTECH_ADMIN_TOKEN=/m.test(content)) {
    content = content.replace(/^CIXTECH_ADMIN_TOKEN=.*/gm, `CIXTECH_ADMIN_TOKEN=${newToken}`);
  } else {
    if (!content.endsWith("\n")) content += "\n";
    content += `CIXTECH_ADMIN_TOKEN=${newToken}\n`;
  }

  writeFileSync(file, content, "utf8");
  const relPath = file.replace(`${repoRoot}\\`, "").replace(`${repoRoot}/`, "");
  console.log(`  ✓ Updated CIXTECH_ADMIN_TOKEN in ${relPath}`);
  updatedCount++;
}

console.log(`\nSuccessfully updated CIXTECH_ADMIN_TOKEN across ${updatedCount} file(s).`);
console.log(
  "Note: If the engine server is running, restart it (or re-run `make dev`) for changes to take effect.\n",
);
