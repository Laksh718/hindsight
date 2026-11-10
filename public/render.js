/**
 * Turning model output and stored records into DOM.
 *
 * Markdown goes through marked, then DOMPurify (model output is untrusted:
 * search results can carry text written by anyone). Citations [n] become
 * links to the source; table cells holding figures get mono numerals; a
 * recheck table's "Changed" cells get the page's one signal colour.
 */
import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';

marked.setOptions({ gfm: true, breaks: false });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Render an answer. `sources` maps citation number to source. */
export function renderAnswer(target, markdown, sources) {
  const html = DOMPurify.sanitize(marked.parse(markdown ?? ''), { ADD_ATTR: ['target'] });
  target.innerHTML = html;
  houseStyle(target);
  linkCitations(target, sources);
  enhanceTables(target);
  for (const a of target.querySelectorAll('a[href^="http"]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
}

/**
 * The prompt asks for no headings or rules; models drift. Rather than trust
 * wording, the renderer enforces the house style: a heading becomes a bold
 * lead-in, a horizontal rule disappears.
 */
function houseStyle(root) {
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const p = document.createElement('p');
    const b = document.createElement('strong');
    b.append(...h.childNodes);
    p.append(b);
    h.replaceWith(p);
  }
  for (const hr of root.querySelectorAll('hr')) hr.remove();
}

function linkCitations(root, sources) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('code, pre, a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) if (/\[\d+(?:\s*,\s*\d+)*\]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = node.nodeValue;
    for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
      frag.append(text.slice(last, m.index));
      for (const n of m[1].split(',').map((x) => Number(x.trim()))) {
        const s = sources.get(n);
        const sup = document.createElement('sup');
        sup.className = 'cite';
        if (s) {
          const a = document.createElement('a');
          a.href = s.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.title = `${s.title}, ${s.domain}${s.published ? `, published ${s.published}` : ''}`;
          a.textContent = n;
          a.setAttribute('aria-label', `Source ${n}: ${s.title}`);
          sup.append(a);
        } else {
          sup.textContent = n;
        }
        frag.append(sup);
      }
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

const FIGURE = /^[~≈<>+\-−]?\s?[$€£¥₹]?\s?\d[\d,.\s]*(?:[%kKmMbB]|bn|GB|TB|MB|ms|s)?(?:\s?(?:\/|per)\s?\w+(?:\s\w+)?)?\.?$/;

function enhanceTables(root) {
  for (const table of root.querySelectorAll('table')) {
    if (!table.parentElement.classList.contains('table-wrap')) {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.replaceWith(wrap);
      wrap.append(table);
    }
    // Figures are classified per cell (mono), alignment per column: a column
    // that is mostly figures aligns right, header included, so it reads down.
    const figures = [];
    const filled = [];
    for (const row of table.querySelectorAll('tbody tr')) {
      [...row.cells].forEach((td, i) => {
        const t = cellText(td);
        if (/^(changed|new|price changed|removed)\b/i.test(t)) td.classList.add('is-changed');
        else if (/^(unchanged|same|no change)\b/i.test(t)) td.classList.add('is-same');
        else if (/^(could not verify|couldn't verify|unverified|unknown)\b/i.test(t)) td.classList.add('is-unknown');
        else if (t.length <= 28 && FIGURE.test(t)) td.classList.add('num');
        if (t) filled[i] = (filled[i] ?? 0) + 1;
        if (td.classList.contains('num')) figures[i] = (figures[i] ?? 0) + 1;
      });
    }
    for (const row of table.rows) {
      [...row.cells].forEach((cell, i) => {
        if (figures[i] && figures[i] * 2 >= (filled[i] ?? 1)) cell.classList.add('col-num');
      });
    }
    // A recheck table (Then / Now / Status): on a changed row, strike the old value through.
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim().toLowerCase());
    const then = heads.findIndex((h) => /^(then|before|was|old)\b/.test(h));
    const now = heads.findIndex((h) => /^(now|today|current|new)\b/.test(h));
    if (then >= 0 && now >= 0) {
      for (const row of table.querySelectorAll('tbody tr')) {
        if (!row.querySelector('.is-changed')) continue;
        row.classList.add('row-changed');
        row.cells[then]?.classList.add('was');
        row.cells[now]?.classList.add('now');
      }
    }
  }
}

/** A cell's text without its citation markers. */
function cellText(td) {
  const copy = td.cloneNode(true);
  copy.querySelectorAll('.cite').forEach((c) => c.remove());
  return copy.textContent.trim();
}

export function sourcesTable(sources, cited) {
  const rows = [...sources]
    .sort((a, b) => Number(cited.has(b.n)) - Number(cited.has(a.n)) || a.n - b.n)
    .map(
      (s) => `<tr class="${cited.has(s.n) ? '' : 'is-uncited'}">
        <td>${s.n}</td>
        <td><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a><span class="sources__domain">${esc(s.domain)}</span></td>
        <td class="num">${esc(s.published ?? '')}</td>
      </tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table><thead><tr><th>No.</th><th>Page</th><th>Published</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function ledgerTable(claims, domainOf) {
  const rows = claims
    .map(
      (k) => `<tr>
        <td>${esc(k.subject)}</td>
        <td>${esc(k.attribute)}</td>
        <td>${esc(k.value)}</td>
        <td>${k.source ? `<a href="${esc(k.source)}" target="_blank" rel="noopener noreferrer">${esc(domainOf(k.source))}</a>` : ''}</td>
      </tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table><thead><tr><th>About</th><th>What</th><th>Value</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function citedNumbers(markdown) {
  const out = new Set();
  for (const m of (markdown ?? '').matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) for (const n of m[1].split(',')) out.add(Number(n.trim()));
  return out;
}

export { esc };
