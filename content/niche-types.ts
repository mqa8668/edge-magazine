// Shape of a niche pack. Copy content/niche.example.ts to content/niche.ts,
// edit it, and point src/pipeline/niche.ts at your copy.

export interface NicheCategory {
  slug: string; // must match a row in the categories table
  name: string;
  tagline: string;
  description: string; // scope sentence; the topic-ideation prompt keeps ideas inside it
}

export interface NichePersona {
  slug: string; // must match an authors.slug row
  name: string;
  voice: string; // style seed appended to the system prompt
  formulas: string[]; // preferred keys of `formulas`
  types: string[]; // preferred keys of `articleTypes`
  categories: string[]; // category slugs this persona is rotated into
}

export interface NichePack {
  siteName: string;
  subject: string; // one phrase describing the topic area, used in editor prompts
  categories: NicheCategory[];
  houseVoice: string; // voice + anti-pattern rules shared by every call
  toneCard: string; // tone + content-safety rules shared by every call
  personas: NichePersona[];
  formulas: Record<string, string>; // copywriting formula cards
  articleTypes: Record<string, string>; // article shapes
  topicSeeds: Record<string, string[]>; // category slug -> starter topics
}
