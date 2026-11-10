/**
 * Build the GitHub Pages site into docs/: a copy of public/ (landing page,
 * the agent, the architecture page, the recorded session).
 *
 * The copy is identical to what `npm run dev` serves, except that chat.html's
 * <html> tag carries data-api (call a hosted API, e.g. on Vercel, so keys
 * stay on the server) or data-replay (play back public/demo/session.json, no
 * server at all).
 *
 *   npm run pages                                          replay mode
 *   HINDSIGHT_API=https://<app>.vercel.app npm run pages   live, via Vercel
 */
import { access, cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs');

await rm(out, { recursive: true, force: true });
await cp(path.join(root, 'public'), out, { recursive: true });
await writeFile(path.join(out, '.nojekyll'), '');

const api = process.env.HINDSIGHT_API?.replace(/\/$/, '');
const chat = path.join(out, 'chat.html');
const html = await readFile(chat, 'utf8');
await writeFile(chat, html.replace('<html lang="en">', api ? `<html lang="en" data-api="${api}">` : '<html lang="en" data-replay="demo">'));

try {
  await access(path.join(out, 'demo/session.json'));
  console.log(api ? `Built docs/: the agent calls ${api}.` : 'Built docs/: the agent replays public/demo/session.json.');
} catch {
  console.log('Built docs/, but there is no recorded session. Record one: npm run seed -- --record public/demo');
}
