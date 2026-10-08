# Niche pack

Everything that makes the drafting pipeline sound like "your" site lives in one file: the site name, the categories, the house voice and safety rules, the AI writing personas, the article formulas, and a few starter topic ideas. `niche.example.ts` is a complete example for a personal-productivity magazine. Its personas are labelled as AI personas, which are writing styles and not real people.

To make your own, copy `niche.example.ts` to `niche.ts` and rewrite it for your topic. Then open `src/pipeline/niche.ts` and change the import from `../../content/niche.example` to `../../content/niche`. TypeScript checks the shape of the pack against `niche-types.ts`, so a missing field shows up when you run `npm run typecheck`.

Keep the category slugs and persona slugs in sync with your database. Each category slug must exist in the `categories` table and each persona slug in `authors` (see `seed/sample.sql`). The admin config page can still override the voice, tone card and persona text at runtime without a redeploy; the pack supplies the defaults.
