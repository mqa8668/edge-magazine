// The single place the active niche pack is chosen. By default it loads the
// bundled example. To use your own, copy content/niche.example.ts to
// content/niche.ts and change the import below to "../../content/niche".
import { niche } from "../../content/niche.example";

export { niche };
export type { NichePack } from "../../content/niche-types";
