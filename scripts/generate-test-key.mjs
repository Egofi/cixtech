import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { loadEnv } from "../apps/api/bundle.mjs";

loadEnv();

const dbUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;

if (!dbUrl) {
  console.error("DATABASE_URL or DIRECT_DATABASE_URL is not set.");
  process.exit(1);
}

const { Pool } = pg;
const ssl =
  dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1")
    ? false
    : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: dbUrl,
  ssl,
});

async function main() {
  const tenantId = randomUUID();
  const keyId = randomUUID();
  const apiKey = `cxk_${randomBytes(24).toString("hex")}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  const tenantName = "app-role-test-tenant";
  const scopes = ["read", "move-funds", "approve"];

  // Insert tenant and api_key
  await pool.query("INSERT INTO tenant (id, name) VALUES ($1, $2)", [tenantId, tenantName]);
  await pool.query(
    "INSERT INTO api_key (key_hash, tenant_id, id, scopes, label) VALUES ($1, $2, $3, $4, $5)",
    [keyHash, tenantId, keyId, scopes, "app-role-test-key"],
  );

  console.log("\n=======================================================");
  console.log("Successfully generated test API key for the app role!");
  console.log(`Tenant ID   : ${tenantId}`);
  console.log(`Tenant Name : ${tenantName}`);
  console.log(`API Key     : ${apiKey}`);
  console.log("=======================================================\n");

  await pool.end();

  return apiKey;
}

main().catch((err) => {
  console.error("Failed to generate test API key:", err);
  process.exit(1);
});
