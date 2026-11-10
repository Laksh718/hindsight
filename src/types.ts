/** The data model. Everything the agent remembers is one of these. */

export interface Source {
  n: number; // citation number, stable within one answer: [n]
  url: string;
  title: string;
  domain: string;
  published?: string; // YYYY-MM-DD when the search provider knows it
  excerpt: string;
}

export interface SearchRecord {
  queries: string[];
  since?: string;
  ms: number;
  results: number;
  cached: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string; // ISO instant, from the turn's clock
  sources?: Source[]; // assistant only: every source it saw, cited or not
  searches?: SearchRecord[];
  recalled?: string[]; // conversation ids pulled from memory for this turn
  ms?: number; // wall time of the whole turn
}

/**
 * A checkable statement the agent made, pulled out of an answer after it was
 * written. The ledger is what turns "is that still true?" from a vague
 * re-search into a list of specific facts to re-verify.
 */
export interface Claim {
  subject: string; // "Neon"
  attribute: string; // "Launch plan price"
  value: string; // "$19 per month"
  source?: string; // URL the value came from
  messageId: string;
  asOf: string; // YYYY-MM-DD the claim was made (user's zone)
}

export interface Conversation {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  tz: string;
  /** Created while the clock was moved (time travel). Shown as such in the UI. */
  simulated?: boolean;
  messages: Message[];
  claims: Claim[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  simulated?: boolean;
  messageCount: number;
  claimCount: number;
}
