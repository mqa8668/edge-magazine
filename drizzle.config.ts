import { defineConfig } from "drizzle-kit";

// Drizzle-kit drives D1 migrations (relational tables in src/db/schema.ts).
// The FTS5 virtual table + triggers are hand-authored (drizzle has no FTS5
// support); see migrations/0001_fts5.sql.
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
