import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatStream, type StreamEvent } from '../src/llm/client.ts';

function sse(chunks: unknown[], splitAt = 7): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Deliver in awkward slices: SSE lines must survive arbitrary chunking.
      for (let i = 0; i < bytes.length; i += splitAt) controller.enqueue(bytes.slice(i, i + splitAt));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of parseChatStream(body)) out.push(ev);
  return out;
}

test('text deltas stream through in order', async () => {
  const events = await collect(sse([
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  assert.deepEqual(events, [
    { type: 'text', text: 'Hel' },
    { type: 'text', text: 'lo' },
    { type: 'finish', reason: 'stop' },
  ]);
});

test('OpenAI-style fragmented tool calls are reassembled', async () => {
  const events = await collect(sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'web_search', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"queries":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '["neon pricing"]}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'web_search', arguments: '{"queries":["x"]}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]));
  const calls = events.find((e) => e.type === 'tool_calls');
  assert.ok(calls && calls.type === 'tool_calls');
  assert.equal(calls.calls.length, 2);
  assert.equal(calls.calls[0]!.function.arguments, '{"queries":["neon pricing"]}');
  assert.equal(calls.calls[1]!.id, 'b');
});

test('Gemini-style whole tool calls keep provider fields (thought signatures)', async () => {
  const events = await collect(sse([
    {
      choices: [{
        delta: {
          tool_calls: [
            { id: 'g1', type: 'function', function: { name: 'web_search', arguments: '{"queries":["a"]}' }, extra_content: { google: { thought_signature: 'sig==' } } },
            { id: 'g2', type: 'function', function: { name: 'web_search', arguments: '{"queries":["b"]}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    },
  ]));
  const calls = events.find((e) => e.type === 'tool_calls');
  assert.ok(calls && calls.type === 'tool_calls');
  assert.equal(calls.calls.length, 2);
  assert.deepEqual(calls.calls[0]!.extra_content, { google: { thought_signature: 'sig==' } });
  assert.equal(calls.calls[1]!.function.arguments, '{"queries":["b"]}');
});
