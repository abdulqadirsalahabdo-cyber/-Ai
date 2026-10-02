// يفهرس PDFs من مجلد books/ إلى data/books.json (OCR عربي عبر Gemini، يدعم الكتب الممسوحة ضوئيًا)
import 'dotenv/config';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
const KEY = process.env.GEMINI_API_KEY, MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash', STEP = 4;
if (!KEY) { console.error('✗ ضع GEMINI_API_KEY في .env'); process.exit(1); }
const META = { 'الفقه_الشافعي': { book: 'دراسات فقهية على مذهب الشافعية', author: null },
  'الطريق': { book: 'رسالة في الطريق إلى ثقافتنا', author: 'محمود محمد شاكر' },
  'نور_اليقين': { book: 'نور اليقين في سيرة سيد المرسلين', author: 'محمد الخضري بك' },
  'النبا_العظيم': { book: 'النبأ العظيم', author: 'محمد عبد الله دراز' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('data', { recursive: true });
const PF = 'data/progress.json', prog = fs.existsSync(PF) ? JSON.parse(fs.readFileSync(PF, 'utf8')) : {};
const files = fs.existsSync('books') ? fs.readdirSync('books').filter((f) => f.toLowerCase().endsWith('.pdf')) : [];
if (!files.length) { console.error('✗ ضع ملفات PDF داخل مجلد books/'); process.exit(1); }
for (const f of files) {
  const src = await PDFDocument.load(fs.readFileSync('books/' + f), { ignoreEncryption: true }), n = src.getPageCount(), pages = (prog[f] ||= {});
  console.log(`\n${f}: ${n} صفحة`);
  for (let s = 0; s < n; s += STEP) {
    if (pages[s + 1] !== undefined) continue;
    const idx = [...Array(Math.min(STEP, n - s)).keys()].map((i) => s + i), d = await PDFDocument.create();
    (await d.copyPages(src, idx)).forEach((p) => d.addPage(p));
    const b64 = Buffer.from(await d.save()).toString('base64');
    let out = null;
    for (let t = 0; t < 5 && !out; t++) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'application/pdf', data: b64 } },
            { text: `Transcribe the Arabic text of each of these ${idx.length} pages faithfully (keep diacritics if present). No commentary, no translation, skip running headers/footers. Return a JSON array of exactly ${idx.length} strings, one per page in order ("" for blank pages).` }] }],
            generationConfig: { temperature: 0, responseMimeType: 'application/json' } }) });
        if (r.status === 429) { await sleep(30000); continue; }
        const j = await r.json(); const a = JSON.parse(j.candidates[0].content.parts[0].text); if (Array.isArray(a)) out = a;
      } catch { await sleep(5000); }
    }
    if (out) idx.forEach((p, i) => (pages[p + 1] = String(out[i] || ''))); else console.log(`  ⚠ فشلت الصفحات ${s + 1}-${s + idx.length} (أعد التشغيل لإكمالها)`);
    fs.writeFileSync(PF, JSON.stringify(prog)); process.stdout.write(`\r  ${Math.min(s + STEP, n)}/${n}`); await sleep(4500);
  }
}
const chunks = [];
for (const f of files) {
  const m = META[Object.keys(META).find((k) => f.includes(k))] || { book: f.replace(/\.pdf$/i, ''), author: null };
  for (const [pg, text] of Object.entries(prog[f] || {})) {
    const w = text.split(/\s+/).filter(Boolean); if (w.length < 15) continue;
    for (let i = 0; i < w.length; i += 220) chunks.push({ book: m.book, author: m.author, page: +pg, text: w.slice(i, i + 250).join(' ') });
  }
}
fs.writeFileSync('data/books.json', JSON.stringify(chunks));
console.log(`\n✓ تم: ${chunks.length} مقطع → data/books.json`);
