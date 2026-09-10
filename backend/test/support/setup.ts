import { afterEach } from "vitest";
import { closeOpenDatabases } from "./fresh-database.js";

afterEach(async () => {
  await closeOpenDatabases();
});
