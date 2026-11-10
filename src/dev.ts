/**
 * Local runner: the API from app.ts plus the UI from public/.
 * (On Vercel neither this file nor serveStatic is used: the CDN serves public/.)
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import app, { memoryMode } from './app.ts';
import { config, setupProblems } from './config.ts';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
app.use('/*', serveStatic({ root: path.relative(process.cwd(), publicDir) || '.' }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`\n  Hindsight is running at http://localhost:${info.port}\n`);
  if (config.llm) console.log(`  model   ${config.llm.label}: ${[config.llm.model, ...config.llm.fallbacks].join(' > ')}`);
  console.log(`  search  ${config.tavilyKey ? 'Tavily' : 'not configured'}`);
  console.log(`  memory  ${memoryMode === 'file' ? config.dataDir : memoryMode}\n`);
  for (const p of setupProblems()) console.log(`  ! ${p}`);
});
