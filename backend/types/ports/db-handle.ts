import type { Kysely } from "kysely";
import type { DB } from "./db.js";

export type Db = Kysely<DB>;
