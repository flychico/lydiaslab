#!/usr/bin/env node
/*
  Market Desk: Lynold's private market research, published encrypted.

  Why encrypted: this repository is public, so anything committed here can be
  read by anyone. Every research note is turned into HTML, then encrypted with
  AES-256-GCM using a key derived from the research password (PBKDF2-SHA256,
  600,000 iterations, per-site salt). Only ciphertext is committed. The page at
  /research/ asks for the password and decrypts in the browser.

  The password is never stored in this repo. Pass it in the environment:
    RESEARCH_PASSWORD=... node scripts/research/research.mjs <command>

  Commands
    build --src <vault folder>      Rebuild everything from an Obsidian vault folder
                                    (keeps the salt so saved logins keep working).
    add --file <note.md> [--folder "Daily Reports"]
                                    Add or replace ONE note (used by the nightly and
                                    pre-market reports). Folder decides the section;
                                    defaults to the note's parent folder name.
    list                            Decrypt the index and print what is published.

  Only Node built-ins are used.
*/
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// RESEARCH_ROOT lets a copy of this script outside the repo (e.g. saved from the Claude Project) work on a checkout.
const ROOT = process.env.RESEARCH_ROOT
  ? path.resolve(process.env.RESEARCH_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'research', 'data');
const DOCS = path.join(OUT, 'docs');
const ITER = 600000;

// ---------------------------------------------------------------- sections
// Vault folder (relative path) -> section shown on the site.
const GROUPS = [
  ['Reports', ['Pre-Market', 'Daily Reports', 'Week Ahead', 'Weekly Reports']],
  ['Research', ['Watchlist & Levels', 'Technical Analysis', 'Options', 'Sectors']],
  ['Federal Reserve', ['Fed & Macro', 'FOMC Minutes', 'Beige Book']],
  ['Library', ['Banks & Funds', 'Masters', 'Plan & Notes']],
];
function sectionFor(folder, name) {
  const f = folder.replace(/\\/g, '/');
  if (/Daily Reports|Weekly Reports/.test(f) || /Pre-Market|Week Ahead|Daily (Recap|Debrief)|Weekly (Report|Coaching)/i.test(name)) {
    if (/pre-market/i.test(name)) return 'Pre-Market';
    if (/week ahead/i.test(name)) return 'Week Ahead';
    if (/weekly/i.test(name) || /Weekly Reports/.test(f)) return 'Weekly Reports';
    return 'Daily Reports';
  }
  if (/FOMC Minutes$/.test(f)) return 'FOMC Minutes';
  if (/Beige Book$/.test(f)) return 'Beige Book';
  if (/^(Federal Reserve|Fed & Macro)/.test(f)) return 'Fed & Macro';
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

// ---------------------------------------------------------------- crypto
function key(password, saltB64) {
  return crypto.pbkdf2Sync(password, Buffer.from(saltB64, 'base64'), ITER, 32, 'sha256');
}
function encrypt(k, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}
function decrypt(k, box) {
  const buf = Buffer.from(box.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'));
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
  return { id, name, title, section, date, snapshot, summary, body, page: fm.page || '', words: body.split(/\s+/).length };
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
  return { id: n.id, name: n.name, title: n.title, section: n.section, date: n.date, snapshot: n.snapshot || undefined, summary: n.summary, words: n.words, page: n.page };
}

// ---------------------------------------------------------------- io
function password() {
  const p = process.env.RESEARCH_PASSWORD;
  if (!p) { console.error('Set RESEARCH_PASSWORD in the environment.'); process.exit(1); }
  return p;
}
function loadMeta() {
  const f = path.join(OUT, 'meta.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
function writeJSON(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); }
function sortIndex(items) {
  return items.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title));
}
function readIndex(k) {
  const f = path.join(OUT, 'index.enc.json');
  if (!fs.existsSync(f)) return { updated: '', groups: GROUPS, items: [] };
  return decrypt(k, JSON.parse(fs.readFileSync(f, 'utf8')));
}
function writeIndex(k, idx) {
  idx.updated = new Date().toISOString();
  idx.groups = GROUPS;
  idx.items = sortIndex(idx.items);
  writeJSON(path.join(OUT, 'index.enc.json'), encrypt(k, idx));
}

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n) => { const i = args.indexOf('--' + n); return i > -1 ? args[i + 1] : undefined; };

if (cmd === 'build') {
  const src = opt('src');
  if (!src || !fs.existsSync(src)) { console.error('build needs --src <vault folder>'); process.exit(1); }
  const pw = password();
  let meta = loadMeta();
  if (!meta) meta = { v: 1, kdf: 'PBKDF2-SHA256', iterations: ITER, salt: crypto.randomBytes(16).toString('base64') };
  const k = key(pw, meta.salt);
  const notes = walk(src).map((f) => parseNote(f.abs, f.folder, fs.readFileSync(f.abs, 'utf8')));
  const seen = new Set();
  for (const n of notes) { while (seen.has(n.id)) n.id += '-2'; seen.add(n.id); }
  const links = linker(notes);
  fs.rmSync(DOCS, { recursive: true, force: true });
  for (const n of notes) writeJSON(path.join(DOCS, n.id + '.json'), encrypt(k, render(n, links)));
  // Check value lets the page tell a wrong password from a broken file.
  meta.check = encrypt(k, { ok: true });
  writeJSON(path.join(OUT, 'meta.json'), meta);
  writeIndex(k, { items: notes.map(indexEntry) });
  console.log(`Published ${notes.length} notes (encrypted) to research/data/.`);
} else if (cmd === 'add') {
  const file = opt('file');
  if (!file || !fs.existsSync(file)) { console.error('add needs --file <note>'); process.exit(1); }
  const pw = password();
  const meta = loadMeta();
  if (!meta) { console.error('No research/data/meta.json yet: run build first.'); process.exit(1); }
  const k = key(pw, meta.salt);
  try { decrypt(k, meta.check); } catch { console.error('Wrong RESEARCH_PASSWORD (it does not match the published data).'); process.exit(1); }
  const idx = readIndex(k);
  const n = parseNote(file, opt('folder') || path.basename(path.dirname(file)), fs.readFileSync(file, 'utf8'));
  const prior = idx.items.find((x) => x.name === n.name);
  if (prior) n.id = prior.id;
  const known = idx.items.map((x) => ({ name: x.name, title: x.title, id: x.id })).concat([n]);
  writeJSON(path.join(DOCS, n.id + '.json'), encrypt(k, render(n, linker(known))));
  idx.items = idx.items.filter((x) => x.id !== n.id).concat([indexEntry(n)]);
  writeIndex(k, idx);
  console.log(`${prior ? 'Replaced' : 'Added'} "${n.title}" in ${n.section} (${idx.items.length} notes total).`);
} else if (cmd === 'list') {
  const meta = loadMeta();
  const k = key(password(), meta.salt);
  const idx = readIndex(k);
  for (const x of idx.items) console.log(`${x.date || '          '}  ${x.section.padEnd(20)} ${x.title}`);
  console.log(`${idx.items.length} notes, updated ${idx.updated}`);
} else {
  console.log('Usage: RESEARCH_PASSWORD=... node scripts/research/research.mjs build --src <vault> | add --file <note.md> [--folder <name>] | list');
}
