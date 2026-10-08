-- Full-text search (FTS5) for posts. Hand-authored: drizzle-kit cannot emit FTS5
-- virtual tables.
--
-- Contentless (content='') index populated by application code on publish using
-- `rowid = posts.id` and a plain-text extraction of processed_html (HTML
-- stripping cannot be done in a SQL trigger). Query with:
--   MATCH ? ORDER BY bm25(posts_fts) LIMIT 20
--
-- remove_diacritics 2 folds diacritics on both indexed tokens and query terms,
-- so "cafe" matches "café" in any language that uses combining marks.
-- Bulk (re)index with POST /api/reindex.

CREATE VIRTUAL TABLE posts_fts USING fts5(
  title,
  excerpt,
  body,
  content='',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
