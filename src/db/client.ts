import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

// Build a typed Drizzle client over the D1 binding. Create one per request.
export function db(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type DB = ReturnType<typeof db>;
export { schema };
