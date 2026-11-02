#!/usr/bin/env node
/**
 * build-verses.mjs — multi-language Bible assets for the game.
 *
 * Emits per language:  verses-<lang>.json  (prize pool, ranked by cross-ref
 * "substance" — same indices for every language, only the text changes)
 * and for EN+ES only:  bible-<lang>.txt    (full 31,102-verse text for the
 * KEEP READING chapter sheet).
 *
 * Usage: node tools/build-verses.mjs [poolSize]   (default 3500)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const XREF = join(ROOT, '../bible-cross-references');
const OUT = join(ROOT, 'public/assets');
const POOL_SIZE = Number(process.argv[2]) || 3500;
const FULL_BIBLE_LANGS = new Set(['en', 'es']);

// Canonical order (66): book id -> index
const BOOK_IDS = ['Gen', 'Exod', 'Lev', 'Num', 'Deut', 'Josh', 'Judg', 'Ruth', '1Sam', '2Sam',
  '1Kgs', '2Kgs', '1Chr', '2Chr', 'Ezra', 'Neh', 'Esth', 'Job', 'Ps', 'Prov', 'Eccl', 'Song',
  'Isa', 'Jer', 'Lam', 'Ezek', 'Dan', 'Hos', 'Joel', 'Amos', 'Obad', 'Jonah', 'Mic', 'Nah',
  'Hab', 'Zeph', 'Hag', 'Zech', 'Mal', 'Matt', 'Mark', 'Luke', 'John', 'Acts', 'Rom', '1Cor',
  '2Cor', 'Gal', 'Eph', 'Phil', 'Col', '1Thess', '2Thess', '1Tim', '2Tim', 'Titus', 'Phlm',
  'Heb', 'Jas', '1Pet', '2Pet', '1John', '2John', '3John', 'Jude', 'Rev'];

// Localized display names per language, same canonical order as BOOK_IDS.
const LANG_BOOKS = {
  es: ['Génesis', 'Éxodo', 'Levítico', 'Números', 'Deuteronomio', 'Josué', 'Jueces', 'Rut', '1 Samuel', '2 Samuel', '1 Reyes', '2 Reyes', '1 Crónicas', '2 Crónicas', 'Esdras', 'Nehemías', 'Ester', 'Job', 'Salmos', 'Proverbios', 'Eclesiastés', 'Cantares', 'Isaías', 'Jeremías', 'Lamentaciones', 'Ezequiel', 'Daniel', 'Oseas', 'Joel', 'Amós', 'Abdías', 'Jonás', 'Miqueas', 'Nahúm', 'Habacuc', 'Sofonías', 'Hageo', 'Zacarías', 'Malaquías', 'Mateo', 'Marcos', 'Lucas', 'Juan', 'Hechos', 'Romanos', '1 Corintios', '2 Corintios', 'Gálatas', 'Efesios', 'Filipenses', 'Colosenses', '1 Tesalonicenses', '2 Tesalonicenses', '1 Timoteo', '2 Timoteo', 'Tito', 'Filemón', 'Hebreos', 'Santiago', '1 Pedro', '2 Pedro', '1 Juan', '2 Juan', '3 Juan', 'Judas', 'Apocalipsis'],
  pt: ['Gênesis', 'Êxodo', 'Levítico', 'Números', 'Deuteronômio', 'Josué', 'Juízes', 'Rute', '1 Samuel', '2 Samuel', '1 Reis', '2 Reis', '1 Crônicas', '2 Crônicas', 'Esdras', 'Neemias', 'Ester', 'Jó', 'Salmos', 'Provérbios', 'Eclesiastes', 'Cântico', 'Isaías', 'Jeremias', 'Lamentações', 'Ezequiel', 'Daniel', 'Oseias', 'Joel', 'Amós', 'Obadias', 'Jonas', 'Miquéias', 'Naum', 'Habacuque', 'Sofonias', 'Ageu', 'Zacarias', 'Malaquias', 'Mateus', 'Marcos', 'Lucas', 'João', 'Atos', 'Romanos', '1 Coríntios', '2 Coríntios', 'Gálatas', 'Efésios', 'Filipenses', 'Colossenses', '1 Tessalonicenses', '2 Tessalonicenses', '1 Timóteo', '2 Timóteo', 'Tito', 'Filemom', 'Hebreus', 'Tiago', '1 Pedro', '2 Pedro', '1 João', '2 João', '3 João', 'Judas', 'Apocalipse'],
  de: ['1. Mose', '2. Mose', '3. Mose', '4. Mose', '5. Mose', 'Josua', 'Richter', 'Rut', '1. Samuel', '2. Samuel', '1. Könige', '2. Könige', '1. Chronik', '2. Chronik', 'Esra', 'Nehemia', 'Esther', 'Hiob', 'Psalm', 'Sprüche', 'Prediger', 'Hoheslied', 'Jesaja', 'Jeremia', 'Klagelieder', 'Hesekiel', 'Daniel', 'Hosea', 'Joel', 'Amos', 'Obadja', 'Jona', 'Micha', 'Nahum', 'Habakuk', 'Zefanja', 'Haggai', 'Sacharja', 'Maleachi', 'Matthäus', 'Markus', 'Lukas', 'Johannes', 'Apostelgeschichte', 'Römer', '1. Korinther', '2. Korinther', 'Galater', 'Epheser', 'Philipper', 'Kolosser', '1. Thessalonicher', '2. Thessalonicher', '1. Timotheus', '2. Timotheus', 'Titus', 'Philemon', 'Hebräer', 'Jakobus', '1. Petrus', '2. Petrus', '1. Johannes', '2. Johannes', '3. Johannes', 'Judas', 'Offenbarung'],
  it: ['Genesi', 'Esodo', 'Levitico', 'Numeri', 'Deuteronomio', 'Giosuè', 'Giudici', 'Rute', '1 Samuele', '2 Samuele', '1 Re', '2 Re', '1 Cronache', '2 Cronache', 'Esdra', 'Neemia', 'Ester', 'Giobbe', 'Salmo', 'Proverbi', 'Ecclesiaste', 'Cantico', 'Isaia', 'Geremia', 'Lamentazioni', 'Ezechiele', 'Daniele', 'Osea', 'Gioele', 'Amos', 'Abdia', 'Giona', 'Michea', 'Naum', 'Abacuc', 'Sofonia', 'Aggeo', 'Zaccaria', 'Malachia', 'Matteo', 'Marco', 'Luca', 'Giovanni', 'Atti', 'Romani', '1 Corinzi', '2 Corinzi', 'Galati', 'Efesini', 'Filippesi', 'Colossesi', '1 Tessalonicesi', '2 Tessalonicesi', '1 Timoteo', '2 Timoteo', 'Tito', 'Filemone', 'Ebrei', 'Giacomo', '1 Pietro', '2 Pietro', '1 Giovanni', '2 Giovanni', '3 Giovanni', 'Giuda', 'Apocalisse'],
};

const TRANSLATIONS = {
  en: 'bsb', es: 'vbl', pt: 'blivre', de: 'luther1912', it: 'riveduta1927',
};

// --- Versification (chapter counts per book id, parsed from the TS source) ---
const versSrc = readFileSync(join(XREF, 'src/core/bible/kjv-versification.ts'), 'utf8');
const countsById = {};
{
  const re = /['"]?(\w+)['"]?:\s*\[([\d,\s]+)\]/g;
  let m;
  while ((m = re.exec(versSrc))) {
    const nums = m[2].split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n));
    if (nums.length) countsById[m[1]] = nums;
  }
}
// verse index -> { bookIdx, chapter, verse }
const meta = new Array(31102);
{
  let idx = 0;
  BOOK_IDS.forEach((id, bi) => {
    countsById[id].forEach((versesInCh, cOff) => {
      for (let v = 1; v <= versesInCh; v++, idx++) meta[idx] = { bi, c: cOff + 1, v };
    });
  });
  if (idx !== 31102) throw new Error(`index mismatch: ${idx}`);
}

// English display names parsed from books.ts (referenceName wins, e.g. "Psalm")
const booksSrc = readFileSync(join(XREF, 'src/core/bible/books.ts'), 'utf8');
const enNames = [];
{
  const re = /\{\s*id:\s*'([^']+)',[\s\S]*?name:\s*'([^']+)'[\s\S]*?\}/g;
  let m;
  while ((m = re.exec(booksSrc)) && enNames.length < 66) {
    const refName = /referenceName:\s*'([^']+)'/.exec(m[0])?.[1];
    enNames.push(refName || m[2]);
  }
}
LANG_BOOKS.en = enNames;

// --- Substance ranking (same for all languages) -------------------------------
const xr = JSON.parse(readFileSync(join(XREF, 'public/data/cross-references/openbible.json'), 'utf8'));
const score = new Float64Array(31102);
const { offsets, targetStart, targetEnd, votes } = xr.links;
for (let i = 0; i < 31102; i++) for (let j = offsets[i]; j < offsets[i + 1]; j++) score[i] += votes[j];
for (let j = 0; j < votes.length; j++) for (let t = targetStart[j]; t <= targetEnd[j]; t++) score[t] += votes[j];
const ranked = Array.from({ length: 31102 }, (_, i) => i).sort((a, b) => score[b] - score[a]);

// --- Emit per language --------------------------------------------------------
mkdirSync(OUT, { recursive: true });
for (const [lang, tId] of Object.entries(TRANSLATIONS)) {
  const data = JSON.parse(readFileSync(join(XREF, `public/data/translations/${tId}.json`), 'utf8'));
  const names = LANG_BOOKS[lang];
  const refOf = (i) => `${names[meta[i].bi]} ${meta[i].c}:${meta[i].v}`;

  const pool = [];
  for (const i of ranked) {
    const t = data.verses[i];
    if (!t || t.trim().length < 25) continue;
    pool.push({ i, r: refOf(i), t: t.trim() });
    if (pool.length >= POOL_SIZE) break;
  }
  writeFileSync(join(OUT, `verses-${lang}.json`), JSON.stringify({
    lang, attribution: data.attribution, license: data.license, verses: pool,
  }));

  if (FULL_BIBLE_LANGS.has(lang)) {
    const txt = data.verses.map((t, i) => `${refOf(i)}\t${(t || '').trim()}`).join('\n');
    writeFileSync(join(OUT, `bible-${lang}.txt`), txt);
    console.log(`bible-${lang}.txt ${(txt.length / 1048576).toFixed(1)} MB`);
  }
  console.log(`verses-${lang}.json ${pool.length} verses | top: ${pool[0].r} | Jer29:11 pos: ${pool.findIndex((p) => p.i === 23099)}`);
}
console.log('done');
