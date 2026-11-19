#!/usr/bin/env node
/*
  Market Desk: market research published at ndhorizon.com/research/.

  Every note is turned into HTML and written as plain JSON under research/data/.
  Personal notes are never published, and every note is cleaned of personal
  details on the way out (see "publishing rules" below).

  Commands
    build --src <vault folder>      Rebuild everything from an Obsidian vault folder.
    add --file <note.md> [--folder "Daily Reports"] [--styled <page.html>]
                                    Add or replace ONE note (used by the nightly and
                                    pre-market reports). Folder decides the section;
                                    defaults to the note's parent folder name.
    style --id <id> --styled <page.html> | remove --id <id> | move --title <t> --section <s>
    static                          Rebuild every note's plain HTML page at /research/<id>/.
    list                            Print what is published.

  Only Node built-ins are used.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// RESEARCH_ROOT lets a copy of this script outside the repo (e.g. saved from the Claude Project) work on a checkout.
const ROOT = process.env.RESEARCH_ROOT
  ? path.resolve(process.env.RESEARCH_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'research', 'data');
const DOCS = path.join(OUT, 'docs');

// ---------------------------------------------------------------- sections
// Vault folder (relative path) -> section shown on the site.
const GROUPS = [
  ['Desk', ['Scorecard', 'Growth', 'Fib Library']],
  ['Reports', ['Pre-Market', 'Daily Reports', 'Week Ahead', 'Weekly Reports']],
  ['Research', ['Earnings', 'Watchlist & Levels', 'Technical Analysis', 'Options', 'Sectors']],
  ['Federal Reserve', ['Fed & Macro', 'FOMC Minutes', 'Beige Book']],
  ['Library', ['Banks & Funds', 'Masters', 'Plan & Notes']],
  ['Archive', ['Archive']],
];
function sectionFor(folder, name) {
  const f = folder.replace(/\\/g, '/');
  const desk = f.match(/^(Today|Scorecard|Growth|Fib Library)$/);
  if (desk) return desk[1];
  if (/Daily Reports|Weekly Reports/.test(f) || /Pre-Market|Week Ahead|Daily (Recap|Debrief)|Weekly (Report|Coaching)/i.test(name)) {
    if (/pre-market/i.test(name)) return 'Pre-Market';
    if (/week ahead/i.test(name)) return 'Week Ahead';
    if (/weekly/i.test(name) || /Weekly Reports/.test(f)) return 'Weekly Reports';
    return 'Daily Reports';
  }
  if (/FOMC Minutes$/.test(f)) return 'FOMC Minutes';
  if (/Beige Book$/.test(f)) return 'Beige Book';
  if (/^(Federal Reserve|Fed & Macro)/.test(f)) return 'Fed & Macro';
  if (/^Earnings/.test(f)) return 'Earnings';
  if (/^Watchlist/.test(f)) return 'Watchlist & Levels';
  if (/^Technical Analysis/.test(f)) return 'Technical Analysis';
  if (/^Options/.test(f)) return 'Options';
  if (/^Sectors/.test(f)) return 'Sectors';
  if (/^Banks & Funds/.test(f)) return 'Banks & Funds';
  if (/^Masters/.test(f)) return 'Masters';
  return 'Plan & Notes';
}
// Never published, whatever the vault holds.
const SKIP_DIRS = /(^|\/)(\.obsidian|My Portfolio|_build|PDFs)(\/|$)/;
// Personal account details are stripped line by line.
const REDACT = [/Individual Cash account/i, /account holds \*\*\$/i, /\$[\d,.]+\*{0,2} in (the|your|his) account/i, /in the account,?\*{0,2}\s+only/i, /\bnet liq/i, /buying power/i, /account (number|value)/i];

// ---------------------------------------------------------------- publishing rules
// Nov 19, 2026: the desk is public. Personal notes are never published, and every note is
// cleaned of personal details on the way out.
const PRIVATE_SECTIONS = ['Growth', 'Plan & Notes'];
const PRIVATE_NAMES = /fib style|fib curriculum|fibonacci curriculum|operating brief|session summary|wealth\s*[—-]\s*home|reading list|trade plan|growth log|my trades/i;
const isPrivate = (n) => PRIVATE_SECTIONS.includes(n.section) || PRIVATE_NAMES.test(n.name || '') || PRIVATE_NAMES.test(n.title || '');
// Whole lines/paragraphs that never go public.
const DROP = [/buffett/i, /\bjessica\b/i, /montoya/i, /@gmail\.com/i, /\$1,000,000|\$1\s?M\b|\$1 million|toward \$1|to \$1 million/i, /\byour trade\b|\bmy-trades\b|real trades?/i, /trufamed|surfside/i, /operating brief/i];
function cleanText(t) {
  if (!t) return t;
  t = String(t);
  t = t.replace(/\s*\((remade|remake|rerun|v2)\)/gi, '').replace(/\b(Remade|Remake|Rerun)\b:?\s*/g, '');
  t = t.replace(/https:\/\/claude\.ai\/[^\s"'<)]*/g, '');
  t = t.replace(/\b(at |by )?3:12( ?(PM|pm|p\.m\.))?( ET)?( New York time)?/g, 'intraday').replace(/afternoon (trigger )?check/gi, 'intraday read');
  t = t.replace(/\bLynold Rivera\b/g, 'the desk').replace(/\bRivera\b/g, '');
  t = t.replace(/(^|[>\n.!?]\s*)Lynold, ([a-z])/g, (_, a, c) => a + c.toUpperCase()).replace(/(^|[>\n]\s*)Lynold, /g, '$1');
  t = t.replace(/\bLynold['’]s\b/g, 'the desk’s').replace(/\bLynold\b/g, 'the desk');
  t = t.replace(/lynolds?-/gi, '').replace(/\blynold\b/gi, 'the desk');
  return t;
}
function cleanHtml(h) {
  if (!h) return h;
  // Drop any block element whose text hits a DROP rule, then clean the rest.
  h = h.replace(/<(p|li|tr|blockquote|h[1-6])\b[^>]*>[\s\S]*?<\/\1>/gi, (blk) => (DROP.some((r) => r.test(blk.replace(/<[^>]+>/g, ' '))) ? '' : blk));
  return cleanText(h);
}
function cleanMd(body) {
  return cleanText(body.split('\n\n').filter((para) => !DROP.some((r) => r.test(para))).join('\n\n'));
}

// ---------------------------------------------------------------- output
function publish(obj) {
  const o = Object.assign({}, obj);
  if (o.html) o.html = cleanHtml(o.html);
  if (o.styled) o.styled = cleanHtml(o.styled);
  if (o.title) o.title = cleanText(o.title);
  delete o.page;
  return o;
}

// ---------------------------------------------------------------- markdown
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function slug(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 90);
}
function inline(s, links) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(esc(c)) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, label) => {
    const id = links(t.trim());
    const text = (label || t).trim();
    return id ? `<a href="#/doc/${id}" class="wl">${text}</a>` : `<span class="wl-miss">${text}</span>`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<span class="img-note">[image: ${a || 'image'}]</span>`);
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}
function splitRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}
export function md2html(src, links) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  while (i < lines.length) {
    let l = lines[i];
    if (/^\s*$/.test(l)) { i++; continue; }
    const fence = l.match(/^\s*(```|~~~)\s*([\w-]*)/);
    if (fence) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="code"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // Inline SVG charts (generated by our own report script) pass through, with anything scriptable stripped.
    if (/^\s*<svg[\s>]/i.test(l)) {
      const buf = [];
      while (i < lines.length) { buf.push(lines[i]); if (/<\/svg>/i.test(lines[i++])) break; }
      const svg = buf.join('\n').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '').replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, '$1#');
      out.push(`<figure class="chart">${svg}</figure>`);
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { const n = Math.min(h[1].length + 1, 6); out.push(`<h${n} id="${slug(h[2])}">${inline(h[2], links)}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(l); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const num = (c) => /^[\s$+\-−–]*[\d.,]+%?[\s*⚠]*$/.test(c) ? ' class="n"' : '';
      out.push(`<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inline(c, links)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td${num(c)}>${inline(c, links)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const first = buf[0] || '';
      const call = first.match(/^\[!(\w+)\][-+]?\s*(.*)$/);
      if (call) buf[0] = call[2] ? `**${call[2]}**` : '';
      out.push(`<blockquote${call ? ` class="callout ${call[1].toLowerCase()}"` : ''}>${md2html(buf.join('\n'), links)}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const items = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m) items.push({ ind: m[1].replace(/\t/g, '    ').length, ord: /\d/.test(m[2]), text: m[3] });
        else items[items.length - 1].text += ' ' + lines[i].trim();
        i++;
      }
      const render = (arr, start) => {
        const base = arr[start].ind; const ord = arr[start].ord;
        let html = ord ? '<ol>' : '<ul>'; let j = start;
        while (j < arr.length && arr[j].ind >= base) {
          if (arr[j].ind > base) { const [sub, nj] = render(arr, j); html = html.replace(/<\/li>$/, sub + '</li>'); j = nj; continue; }
          let t = arr[j].text; let cls = '';
          const task = t.match(/^\[( |x|X)\]\s+(.*)$/);
          if (task) { cls = ' class="task"'; t = `<span class="box${task[1] === ' ' ? '' : ' on'}"></span>${inline(task[2], links)}`; } else t = inline(t, links);
          html += `<li${cls}>${t}</li>`; j++;
        }
        return [html + (ord ? '</ol>' : '</ul>'), j];
      };
      let j = 0;
      while (j < items.length) { const [html, nj] = render(items, j); out.push(html); j = nj; }
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) buf.push(lines[i++].trim());
    if (buf.length) out.push(`<p>${inline(buf.join(' '), links)}</p>`);
    else i++;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- notes
// After redaction a heading can be left with nothing under it; drop such headings.
function dropEmptySections(body) {
  const lines = body.split('\n');
  const lvl = (l) => { const m = l.match(/^(#{1,6})\s/); return m ? m[1].length : 0; };
  const keep = lines.map(() => true);
  for (let i = 0; i < lines.length; i++) {
    const L = lvl(lines[i]); if (!L) continue;
    let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length || (lvl(lines[j]) && lvl(lines[j]) <= L) || /^(---|\*\*\*)\s*$/.test(lines[j])) keep[i] = false;
  }
  return lines.filter((_, i) => keep[i]).join('\n');
}
function parseNote(file, relFolder, raw) {
  const name = path.basename(file).replace(/\.(md|txt)$/i, '');
  let body = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const fm = {};
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    body = body.slice(m[0].length);
    for (const line of m[1].split('\n')) { const kv = line.match(/^([\w-]+):\s*(.*)$/); if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, ''); }
  }
  body = body.split('\n').filter((l) => !REDACT.some((r) => r.test(l))).join('\n');
  body = cleanMd(body);
  body = dropEmptySections(body);
  if (/\.txt$/i.test(file)) body = '```\n' + body + '\n```';
  let title = name;
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1 && body.trim().startsWith('#')) { title = h1[1].trim(); body = body.replace(/^#\s+.+\n?/m, ''); }
  // Reports carry `date`; reference notes and screens carry `as_of` (a snapshot) or `updated`.
  const dm = (fm.date || name).match(/(\d{4}-\d{2}-\d{2})/);
  const am = !dm && (fm.as_of || fm.updated || '').match(/(\d{4}-\d{2}-\d{2})/);
  const date = dm ? dm[1] : am ? am[1] : '';
  const snapshot = !dm && !!am;
  const section = sectionFor(relFolder, name);
  const firstPara = body.split('\n\n').map((p) => p.trim()).find((p) => p && !/^(#|\||```|- \[|>|<)/.test(p)) || '';
  const summary = firstPara.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a).replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').slice(0, 220);
  const id = slug((date ? '' : section + ' ') + name);
  // `tickers: SPY QQQ DAL ...` in frontmatter (the Today note) drives the ticker chips on the home page.
  const tickers = (fm.tickers || '').toUpperCase().match(/[A-Z][A-Z.]{0,5}/g) || undefined;
  return { id, name, title, section, date, snapshot, summary, body, page: fm.page || '', tickers, words: body.split(/\s+/).length };
}
function walk(dir, rel = '') {
  let files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (SKIP_DIRS.test(r) || e.name.startsWith('.') || e.name.startsWith('~$')) continue;
    if (e.isDirectory()) files = files.concat(walk(path.join(dir, e.name), r));
    else if (/\.(md|txt)$/i.test(e.name)) files.push({ abs: path.join(dir, e.name), folder: rel });
  }
  return files;
}
function linker(notes) {
  const byName = new Map();
  for (const n of notes) { byName.set(n.name.toLowerCase(), n.id); byName.set(n.title.toLowerCase(), n.id); }
  return (t) => byName.get(t.toLowerCase().split('#')[0].trim()) || null;
}
function render(n, links) {
  return { id: n.id, title: n.title, section: n.section, date: n.date, page: n.page, html: md2html(n.body, links) };
}
function indexEntry(n) {
  return { id: n.id, name: n.name, title: n.title, section: n.section, date: n.date, snapshot: n.snapshot || undefined, summary: n.summary, words: n.words, page: n.page, tickers: n.tickers };
}

// ---------------------------------------------------------------- io
function writeJSON(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); }
function sortIndex(items) {
  return items.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title));
}
function readIndex() {
  const f = path.join(OUT, 'index.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { updated: '', groups: GROUPS, items: [] };
}
function writeIndex(idx) {
  idx.updated = new Date().toISOString();
  idx.groups = GROUPS;
  idx.items = sortIndex(idx.items.filter((x) => !isPrivate(x)).map((x) => Object.assign({}, x, { title: cleanText(x.title), summary: DROP.some((r) => r.test(x.summary || '')) ? '' : cleanText(x.summary), page: undefined })));
  writeJSON(path.join(OUT, 'index.json'), idx);
}

// ---------------------------------------------------------------- static pages
// Nov 19, 2026 (Lynold: "Build a plain HTML page for every note, and remove the stay-away tag and add
// the research pages to the sitemap"): every note also gets a plain HTML page at /research/<id>/ that
// search engines and AI tools can read without JavaScript, and /research/ lists every note as plain links.
// The site's sitemap is rebuilt by scripts/generate-sitemap.js, which picks these pages up on its own.
const SITE = 'https://ndhorizon.com';
const RES = path.join(ROOT, 'research');
const escA = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDate = (d) => { if (!d) return ''; const [y, m, day] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
function readerCss() {
  const f = path.join(RES, 'index.html');
  if (!fs.existsSync(f)) return '';
  const m = fs.readFileSync(f, 'utf8').match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : '';
}
const fixLinks = (h) => String(h || '').replace(/href="#\/doc\/([^"#]+)"/g, 'href="/research/$1/"');
function staticPage(doc, entry) {
  const url = `${SITE}/research/${entry.id}/`;
  const desc = escA((entry.summary || doc.title || '').slice(0, 300));
  const title = escA(doc.title || entry.title);
  const headTags = `<link rel="canonical" href="${url}"><meta name="description" content="${desc}"><meta name="robots" content="index, follow">`
    + `<meta property="og:title" content="${title}"><meta property="og:description" content="${desc}"><meta property="og:url" content="${url}"><meta property="og:type" content="article">`
    + `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: doc.title || entry.title, datePublished: entry.date || undefined, mainEntityOfPage: url, publisher: { '@type': 'Organization', name: 'Market Desk', url: SITE + '/research/' } }).replace(/</g, '\\u003c')}</script>`;
  const bar = `<div style="font:14px/1.4 Arial,sans-serif;padding:10px 16px;border-bottom:1px solid #e3dacb;background:#fff"><a href="/research/" style="color:#1a2535;font-weight:700;text-decoration:none">Market Desk</a> · <a href="/research/#/doc/${entry.id}" style="color:#7a5e12">Open in the reader</a></div>`;
  const foot = `<p style="font:13px/1.5 Arial,sans-serif;color:#3d3830;padding:16px">Educational research, not personal investment advice.</p>`;
  if (doc.styled && /<html[\s>]/i.test(doc.styled)) {
    let h = fixLinks(doc.styled).replace(/<meta[^>]+name=["']robots["'][^>]*>/gi, '');
    h = h.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title} | Market Desk</title>`);
    h = /<\/head>/i.test(h) ? h.replace(/<\/head>/i, headTags + '</head>') : headTags + h;
    h = /<body[^>]*>/i.test(h) ? h.replace(/<body([^>]*)>/i, `<body$1>${bar}`) : bar + h;
    return h.replace(/<\/body>/i, foot + '</body>');
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} | Market Desk</title>${headTags}`
    + `<link rel="stylesheet" href="/css/style.css"><style>${readerCss()} .static-wrap{max-width:820px;margin:0 auto;padding:24px 18px 40px}</style></head><body>`
    + `<header class="md-top"><div class="md-top-in"><a class="md-brand" href="/research/">Market <b>Desk</b></a></div></header>`
    + `<main class="static-wrap"><p class="crumb"><a href="/research/">Market Desk</a> / ${escA(entry.section)}</p><h1 class="page-h1">${title}</h1>`
    + `<div class="doc-meta">${entry.date ? `<span>${fmtDate(entry.date)}</span>` : ''}<span>${Math.max(1, Math.round((entry.words || 200) / 230))} min read</span><a href="/research/#/doc/${entry.id}">Open in the reader</a></div>`
    + `<article class="doc">${fixLinks(doc.html)}</article></main>${foot}</body></html>`;
}
function writeStatic(id) {
  const idx = readIndex();
  const entry = idx.items.find((x) => x.id === id);
  const f = path.join(DOCS, id + '.json');
  if (!entry || !fs.existsSync(f)) return;
  const dir = path.join(RES, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), staticPage(JSON.parse(fs.readFileSync(f, 'utf8')), entry));
}
function removeStatic(id) { if (id && id !== 'data') fs.rmSync(path.join(RES, id), { recursive: true, force: true }); }
function writeHubList() {
  // Plain links to every note inside /research/, between markers; the reader replaces them once it loads.
  const f = path.join(RES, 'index.html');
  if (!fs.existsSync(f)) return;
  const idx = readIndex();
  const groups = {};
  for (const x of idx.items) (groups[x.section] = groups[x.section] || []).push(x);
  const order = GROUPS.flatMap(([, secs]) => secs).filter((s) => groups[s]);
  const list = order.map((s) => `<h2>${escA(s)}</h2><ul>${groups[s].map((x) => `<li><a href="/research/${x.id}/">${escA(x.title)}</a>${x.date ? ` <span>${fmtDate(x.date)}</span>` : ''}</li>`).join('')}</ul>`).join('');
  const block = `<!--STATIC-LIST--><div class="static-list"><h1 class="page-h1">Market Desk</h1><p class="lead">Daily market reports, key price levels, a Federal Reserve archive and a research library. Free to read. For information only, not investment advice.</p>${list}</div><!--/STATIC-LIST-->`;
  let h = fs.readFileSync(f, 'utf8');
  if (h.includes('<!--STATIC-LIST-->')) h = h.replace(/<!--STATIC-LIST-->[\s\S]*?<!--\/STATIC-LIST-->/, block);
  else h = h.replace('<div id="view"></div>', `<div id="view">${block}</div>`);
  fs.writeFileSync(f, h);
}

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n) => { const i = args.indexOf('--' + n); return i > -1 ? args[i + 1] : undefined; };

if (cmd === 'build') {
  const src = opt('src');
  if (!src || !fs.existsSync(src)) { console.error('build needs --src <vault folder>'); process.exit(1); }
  const notes = walk(src).map((f) => parseNote(f.abs, f.folder, fs.readFileSync(f.abs, 'utf8'))).filter((n) => !isPrivate(n));
  const seen = new Set();
  for (const n of notes) { while (seen.has(n.id)) n.id += '-2'; seen.add(n.id); }
  const links = linker(notes);
  fs.rmSync(DOCS, { recursive: true, force: true });
  for (const n of notes) writeJSON(path.join(DOCS, n.id + '.json'), publish(render(n, links)));
  writeIndex({ items: notes.map(indexEntry) });
  for (const n of notes) writeStatic(n.id);
  writeHubList();
  console.log(`Published ${notes.length} notes to research/data/.`);
} else if (cmd === 'add') {
  const file = opt('file');
  if (!file || !fs.existsSync(file)) { console.error('add needs --file <note>'); process.exit(1); }
  const idx = readIndex();
  const n = parseNote(file, opt('folder') || path.basename(path.dirname(file)), fs.readFileSync(file, 'utf8'));
  // The Today page was retired by Lynold on Nov 12, 2026 ("The today report needs to end. I just want the Daily Debrief").
  if (n.section === 'Today') { console.log('Skipped: the Today page is retired; the Daily Debrief is the nightly read. Nothing was published for it.'); process.exit(0); }
  if (isPrivate(n)) { console.log(`Skipped "${n.title}": personal notes are not published on the public desk.`); process.exit(0); }
  const prior = idx.items.find((x) => x.name === n.name);
  if (prior) n.id = prior.id;
  const known = idx.items.map((x) => ({ name: x.name, title: x.title, id: x.id })).concat([n]);
  const out = render(n, linker(known));
  // --styled <page.html>: the report's own designed page; Market Desk shows it in place of the plain rendering.
  const styled = opt('styled');
  if (styled) { if (!fs.existsSync(styled)) { console.error('add: --styled file not found: ' + styled); process.exit(1); } out.styled = fs.readFileSync(styled, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, ''); }
  writeJSON(path.join(DOCS, n.id + '.json'), publish(out));
  idx.items = idx.items.filter((x) => x.id !== n.id).concat([Object.assign(indexEntry(n), styled ? { styled: true } : {})]);
  writeIndex(idx);
  writeStatic(n.id); writeHubList();
  console.log(`${prior ? 'Replaced' : 'Added'} "${n.title}" in ${n.section} (${idx.items.length} notes total).`);
} else if (cmd === 'move') {
  // Re-file a published note under another section (e.g. --section Archive) without touching the vault.
  const want = opt('title'), section = opt('section');
  if (!want || !section) { console.error('move needs --title "<exact title>" --section <name>'); process.exit(1); }
  const idx = readIndex();
  const x = idx.items.find((i) => i.title === want || i.id === want);
  if (!x) { console.error(`No note titled "${want}".`); process.exit(1); }
  const f = path.join(DOCS, x.id + '.json');
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  doc.section = section; x.section = section;
  writeJSON(f, publish(doc));
  writeIndex(idx);
  writeStatic(x.id); writeHubList();
  console.log(`Moved "${x.title}" to ${section}.`);
} else if (cmd === 'style') {
  // Attach a report's designed page to a note that is already published: style --id <id or exact title> --styled <page.html>
  const want = opt('id') || opt('title'), styled = opt('styled');
  if (!want || !styled || !fs.existsSync(styled)) { console.error('style needs --id <id or exact title> --styled <page.html>'); process.exit(1); }
  const idx = readIndex();
  const x = idx.items.find((i) => i.id === want || i.title === want);
  if (!x) { console.error(`No note "${want}".`); process.exit(1); }
  const f = path.join(DOCS, x.id + '.json');
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  doc.styled = fs.readFileSync(styled, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');
  x.styled = true;
  writeJSON(f, publish(doc));
  writeIndex(idx);
  writeStatic(x.id);
  console.log(`Attached the designed page to "${x.title}".`);
} else if (cmd === 'remove') {
  // Take a published note off the site: remove --id <id or exact title>
  const want = opt('id') || opt('title');
  if (!want) { console.error('remove needs --id <id or exact title>'); process.exit(1); }
  const idx = readIndex();
  const x = idx.items.find((i) => i.id === want || i.title === want);
  if (!x) { console.error(`No note "${want}".`); process.exit(1); }
  fs.rmSync(path.join(DOCS, x.id + '.json'), { force: true });
  idx.items = idx.items.filter((i) => i.id !== x.id);
  writeIndex(idx);
  removeStatic(x.id); writeHubList();
  console.log(`Removed "${x.title}" (${idx.items.length} notes left).`);
} else if (cmd === 'static') {
  // Rebuild every note's plain HTML page and the list on /research/.
  const idx = readIndex();
  for (const x of idx.items) writeStatic(x.id);
  writeHubList();
  console.log(`Wrote ${idx.items.length} plain pages under research/.`);
} else if (cmd === 'list') {
  const idx = readIndex();
  for (const x of idx.items) console.log(`${x.date || '          '}  ${x.section.padEnd(20)} ${x.title}`);
  console.log(`${idx.items.length} notes, updated ${idx.updated}`);
} else {
  console.log('Usage: node scripts/research/research.mjs build --src <vault> | add --file <note.md> [--folder <name>] [--styled <page.html>] | style --id <id> --styled <page.html> | remove --id <id> | move --title <title> --section <name> | static | list');
}
