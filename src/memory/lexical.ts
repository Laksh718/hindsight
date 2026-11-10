/**
 * A small BM25 index over past conversations, for topic recall.
 *
 * It replaced a library: recall needs only field boosts, prefix matching and
 * "how many of the query's words matched", the corpus is one user's chats,
 * and owning sixty lines beats explaining a dependency's module quirks
 * (its CommonJS typings broke the Vercel build).
 *
 * BM25 per field: idf(term) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len / avgLen)),
 * times the field's boost, summed. A query word of four or more letters also
 * matches longer words that start with it ("price" finds "pricing"), at half weight.
 */

const K1 = 1.2;
const B = 0.75;

export interface LexicalDoc {
  id: string;
  fields: Record<string, string>;
}

export interface LexicalHit {
  id: string;
  score: number;
  /** Distinct query words that matched something in the document. */
  matched: number;
}

export function tokenize(text: string, stopwords: Set<string>): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2 && !stopwords.has(t));
}

export class LexicalIndex {
  private docs: Array<{ id: string; fields: Map<string, Map<string, number>>; lengths: Map<string, number> }> = [];
  private df = new Map<string, number>(); // documents containing each term (any field)
  private avgLen = new Map<string, number>();

  constructor(
    docs: LexicalDoc[],
    private readonly boosts: Record<string, number>,
    private readonly stopwords: Set<string>,
  ) {
    const totals = new Map<string, number>();
    for (const doc of docs) {
      const fields = new Map<string, Map<string, number>>();
      const lengths = new Map<string, number>();
      const seen = new Set<string>();
      for (const [name, text] of Object.entries(doc.fields)) {
        const tf = new Map<string, number>();
        const tokens = tokenize(text, stopwords);
        for (const t of tokens) {
          tf.set(t, (tf.get(t) ?? 0) + 1);
          seen.add(t);
        }
        fields.set(name, tf);
        lengths.set(name, tokens.length);
        totals.set(name, (totals.get(name) ?? 0) + tokens.length);
      }
      for (const t of seen) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: doc.id, fields, lengths });
    }
    for (const [name, total] of totals) this.avgLen.set(name, total / Math.max(docs.length, 1));
  }

  search(query: string): LexicalHit[] {
    const terms = [...new Set(tokenize(query, this.stopwords))];
    const n = this.docs.length;
    const hits: LexicalHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      let matched = 0;
      for (const q of terms) {
        let termScore = 0;
        for (const [name, tf] of doc.fields) {
          const boost = this.boosts[name] ?? 1;
          const len = doc.lengths.get(name) ?? 0;
          const norm = 1 - B + (B * len) / Math.max(this.avgLen.get(name) ?? 1, 1);
          for (const [term, count] of tf) {
            const exact = term === q;
            if (!exact && !(q.length >= 4 && term.startsWith(q))) continue;
            const df = this.df.get(term) ?? 0;
            const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
            termScore += boost * idf * ((count * (K1 + 1)) / (count + K1 * norm)) * (exact ? 1 : 0.5);
          }
        }
        if (termScore > 0) {
          score += termScore;
          matched++;
        }
      }
      if (score > 0) hits.push({ id: doc.id, score, matched });
    }
    return hits.sort((a, b) => b.score - a.score);
  }
}
