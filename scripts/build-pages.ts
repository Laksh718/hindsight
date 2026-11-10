/**
 * Build the GitHub Pages site into docs/.
 *
 *   docs/               the real UI, copied from public/, in replay mode
 *   docs/demo/          session.json, recorded by `npm run seed -- --record docs/demo`
 *
 * The app copy is identical to what `npm run dev` serves, except that the
 * <html> tag carries data-replay, which swaps the live API for ReplayApi.
 */
import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs');

// Replace the UI files, keep the recorded demo.
for (const f of ['index.html', 'app.js', 'api.js', 'render.js', 'favicon.svg', 'styles', 'vendor', 'app']) {
  await rm(path.join(out, f), { recursive: true, force: true });
}
await mkdir(path.join(out, 'vendor'), { recursive: true });
await cp(path.join(root, 'public'), out, { recursive: true });
await cp(path.join(root, 'node_modules/marked/lib/marked.esm.js'), path.join(out, 'vendor/marked.js'));
await cp(path.join(root, 'node_modules/dompurify/dist/purify.es.mjs'), path.join(out, 'vendor/purify.js'));

const indexPath = path.join(out, 'index.html');
const html = await readFile(indexPath, 'utf8');
await writeFile(indexPath, html.replace('<html lang="en">', '<html lang="en" data-replay="demo">'));
await writeFile(path.join(root, 'docs', '.nojekyll'), '');

try {
  await access(path.join(root, 'docs/demo/session.json'));
  console.log('Built docs/ (replay mode). Demo session found.');
} catch {
  console.log('Built docs/, but docs/demo/session.json is missing. Record one: npm run seed -- --record docs/demo');
}
