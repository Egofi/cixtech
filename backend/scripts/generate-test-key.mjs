import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { loadEnv } from "../apps/api/bundle.mjs";

loadEnv();

const { Pool } = pg;

const targetUrls = new Set();
const envUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (envUrl) targetUrls.add(envUrl);
targetUrls.add("postgresql://cixtech_owner:cixtech_owner_secret@localhost:5432/cixtech");

async function main() {
  const tenantId = randomUUID();
  const keyId = randomUUID();
  const apiKey = `cxk_${randomBytes(24).toString("hex")}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  const tenantName = "app-role-test-tenant";
  const scopes = ["read", "move-funds", "approve"];

  let successCount = 0;

  for (const dbUrl of targetUrls) {
    const ssl =
      dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1")
        ? false
        : { rejectUnauthorized: false };
    const pool = new Pool({ connectionString: dbUrl, ssl, connectionTimeoutMillis: 3000 });

    try {
      await pool.query(
        "INSERT INTO tenant (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [tenantId, tenantName],
      );
      await pool.query(
        "INSERT INTO api_key (key_hash, tenant_id, id, scopes, label) VALUES ($1, $2, $3, $4, $5)",
        [keyHash, tenantId, keyId, scopes, "app-role-test-key"],
      );
      const hostLabel =
        dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1")
          ? "Local Docker Postgres"
          : "Configured DATABASE_URL";
      console.log(`  ✓ Inserted key into ${hostLabel}`);
      successCount++;
    } catch (err) {
      // Ignore connection failures for inactive databases
    } finally {
      await pool.end().catch(() => {});
    }
  }

  if (successCount === 0) {
    console.error("Failed to insert API key into any reachable database.");
    process.exit(1);
  }

  console.log("\n=======================================================");
  console.log("Successfully generated test API key!");
  console.log(`Tenant ID   : ${tenantId}`);
  console.log(`Tenant Name : ${tenantName}`);
  console.log(`API Key     : ${apiKey}`);
  console.log("=======================================================\n");

  return apiKey;
}

main().catch((err) => {
  console.error("Failed to generate test API key:", err);
  process.exit(1);
});
