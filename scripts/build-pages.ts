/**
 * Build the GitHub Pages site into docs/.
 *
 *   docs/               the real UI, copied from public/, in replay mode
 *   docs/demo/          session.json, recorded by `npm run seed -- --record docs/demo`
 *
 * The app copy is identical to what `npm run dev` serves, except that the
 * <html> tag carries data-api (call a hosted API, e.g. on Vercel) or
 * data-replay (play back a recorded session, no server at all).
 */
import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs');

// Replace the UI files, keep the recorded demo.
for (const f of ['index.html', 'app.js', 'api.js', 'render.js', 'favicon.svg', 'styles', 'vendor', 'app']) {
  await rm(path.join(out, f), { recursive: true, force: true });
}
await mkdir(out, { recursive: true });
await cp(path.join(root, 'public'), out, { recursive: true });

// With HINDSIGHT_API set (your Vercel URL), the Pages copy talks to that live
// API: keys stay on the server. Without it, the page replays a recorded session.
const api = process.env.HINDSIGHT_API?.replace(/\/$/, '');
const indexPath = path.join(out, 'index.html');
const html = await readFile(indexPath, 'utf8');
await writeFile(indexPath, html.replace('<html lang="en">', api ? `<html lang="en" data-api="${api}">` : '<html lang="en" data-replay="demo">'));
if (api) console.log(`Pages UI will call the live API at ${api}`);
await writeFile(path.join(root, 'docs', '.nojekyll'), '');

try {
  await access(path.join(root, 'docs/demo/session.json'));
  console.log('Built docs/ (replay mode). Demo session found.');
} catch {
  console.log('Built docs/, but docs/demo/session.json is missing. Record one: npm run seed -- --record docs/demo');
}
