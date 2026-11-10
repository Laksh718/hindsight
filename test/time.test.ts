import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarTable, dayKey, resolveDates, tzOffsetMinutes } from '../src/time.ts';

// Tuesday 10 November 2026, 21:30 in India.
const NOW = new Date('2026-11-10T16:00:00Z');
const TZ = 'Asia/Kolkata';
const resolve = (text: string) => resolveDates(text, NOW, TZ).map((w) => `${w.from}..${w.to}${w.alternative ? '?' : ''}`);

test('day keys follow the user, not the server', () => {
  assert.equal(dayKey(NOW, TZ), '2026-11-10');
  // 01:00 UTC on the 11th is still the 10th in Los Angeles.
  assert.equal(dayKey(new Date('2026-11-11T01:00:00Z'), 'America/Los_Angeles'), '2026-11-10');
  assert.equal(tzOffsetMinutes(NOW, TZ), 330);
});

test('the three challenge prompts', () => {
  assert.deepEqual(resolve('On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?'), ['2026-11-09..2026-11-09']);
  // "today" points at the present, so it is not a memory window.
  assert.deepEqual(resolve('What did I ask you on 3 November? Is your answer still correct today?'), ['2026-11-03..2026-11-03']);
  assert.deepEqual(resolve('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?'), ['2026-11-03..2026-11-03']);
});

test('bare weekdays always mean the most recent past one', () => {
  assert.deepEqual(resolve('on Friday'), ['2026-11-06..2026-11-06']); // chrono alone says the 13th
  assert.deepEqual(resolve('what did I ask on Tuesday'), ['2026-11-03..2026-11-03']); // today is Tuesday
});

test('"last Monday" said on a Tuesday is ambiguous, so both readings are kept', () => {
  assert.deepEqual(resolve('last Monday'), ['2026-11-09..2026-11-09', '2026-11-02..2026-11-02?']);
});

test('spans', () => {
  assert.deepEqual(resolve('what did we talk about last week'), ['2026-11-02..2026-11-08']);
  assert.deepEqual(resolve('anything this week?'), ['2026-11-09..2026-11-10']);
  assert.deepEqual(resolve('the other day you said'), ['2026-11-03..2026-11-09']);
  assert.deepEqual(resolve('in the past 3 days'), ['2026-11-07..2026-11-10']);
  assert.deepEqual(resolve('last month'), ['2026-10-01..2026-10-31']);
});

test('a date later this year means last year', () => {
  assert.deepEqual(resolve('what did I ask on 25 November'), ['2025-11-25..2025-11-25']);
});

test('no dates, no windows', () => {
  assert.deepEqual(resolve('What is the cheapest managed Postgres for 5 people?'), []);
  assert.deepEqual(resolve('Is it still true now?'), []);
});

test('the prompt calendar names last week explicitly', () => {
  const cal = calendarTable(NOW, TZ);
  assert.match(cal, /^Tue 10 Nov 2026 {2}\(today\)/);
  assert.match(cal, /Mon 9 Nov 2026 {2}\(yesterday, this Monday\)/);
  assert.match(cal, /Tue 3 Nov 2026 {2}\(7 days ago, last week's Tuesday\)/);
});
