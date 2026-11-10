import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LexicalIndex, tokenize } from '../src/memory/lexical.ts';

const stop = new Set(['the', 'for', 'a']);
const index = new LexicalIndex(
  [
    { id: 'pg', fields: { title: 'Managed Postgres hosting prices', body: 'Neon and Supabase pricing for a small team' } },
    { id: 'crm', fields: { title: 'CRM shortlist', body: 'Pipedrive pricing per seat for the sales team' } },
    { id: 'dal', fields: { title: 'Dal recipe', body: 'lentils, cumin, ghee' } },
  ],
  { title: 3, body: 1 },
  stop,
);

test('tokenize drops stopwords, punctuation and single letters', () => {
  assert.deepEqual(tokenize('The price, for a 5-person team!', stop), ['price', 'person', 'team']);
});

test('title matches outrank body matches; unrelated docs never score', () => {
  const hits = index.search('postgres pricing');
  assert.equal(hits[0]!.id, 'pg');
  assert.ok(!hits.some((h) => h.id === 'dal'));
});

test('a word of four letters or more matches longer words by prefix', () => {
  assert.deepEqual(index.search('pric').map((h) => h.id).sort(), ['crm', 'pg']); // "prices", "pricing"
  assert.deepEqual(index.search('price').map((h) => h.id), ['pg']); // "prices" yes, "pricing" no
});

test('matched counts distinct query words that hit', () => {
  const pg = index.search('postgres neon recipe').find((h) => h.id === 'pg');
  assert.equal(pg?.matched, 2);
});
