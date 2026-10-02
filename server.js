import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';

const { JWT_SECRET = crypto.randomBytes(32).toString('hex'), GEMINI_API_KEY, SMTP_USER, SMTP_PASS, PORT = 3000 } = process.env;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(express.static('public'));

const mail = SMTP_USER ? nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } }) : null;
const otps = new Map(); // email -> {h, exp, tries}  (في الذاكرة فقط، لا تخزين دائم للبريد)
const H = (s) => crypto.createHash('sha256').update(s + JWT_SECRET).digest('hex');
const lim = (min, max) => rateLimit({ windowMs: min * 60000, max, standardHeaders: true, legacyHeaders: false });

// ---------- المصادقة بكود تأكيد مختلف لكل مستخدم/محاولة ----------
app.post('/api/auth/request', lim(10, 5), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'bad_email' });
  const code = String(crypto.randomInt(100000, 1000000));
  otps.set(email, { h: H(code), exp: Date.now() + 6e5, tries: 0 });
  try {
    if (mail) await mail.sendMail({ from: `"MIZAN AI | ميزان" <${SMTP_USER}>`, to: email, subject: `MIZAN AI — ${code}`,
      text: `Your verification code / كود التحقق: ${code}\nValid 10 minutes / صالح 10 دقائق.` });
    else console.log(`[DEV] code for ${email}: ${code}`);
    res.json({ ok: true });
  } catch { res.status(502).json({ error: 'mail_failed' }); }
});
app.post('/api/auth/verify', lim(10, 15), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), code = String(req.body.code || '');
  const o = otps.get(email);
  if (!o || o.exp < Date.now() || o.tries >= 5) return res.status(400).json({ error: 'expired' });
  o.tries++;
  const ok = crypto.timingSafeEqual(Buffer.from(H(code)), Buffer.from(o.h));
  if (!ok) return res.status(400).json({ error: 'wrong_code' });
  otps.delete(email);
  res.json({ token: jwt.sign({ sub: H(email).slice(0, 16) }, JWT_SECRET, { expiresIn: '7d' }) });
});
const auth = (req, res, next) => {
  try { jwt.verify((req.headers.authorization || '').slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'unauthorized' }); }
};

// ---------- المرجعية العلمية (من حزمة التحدي) ----------
const ALLOWED = ['dorar.net', 'shamela.ws', 'quranpedia.net', 'dawa.center', 'islamic-content.com'];
const okUrl = (u) => { try { const h = new URL(u).hostname; return ALLOWED.some((d) => h === d || h.endsWith('.' + d)); } catch { return false; } };


// ---------- الاسترجاع (RAG) من مصادر حقيقية ----------
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const get = (u, ms = 8000) => fetch(u, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'MizanAI/1.0' } });
const gem = (body) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function arabicQuery(q) {
  if (/[\u0600-\u06FF]/.test(q)) return q.slice(0, 120);
  try {
    const r = await gem({ contents: [{ role: 'user', parts: [{ text: 'Output ONLY 2-4 Arabic keywords (space separated) to search hadith/Islamic sources for:\n' + q.slice(0, 300) }] }], generationConfig: { temperature: 0 } });
    return ((await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || '').trim().slice(0, 100);
  } catch { return ''; }
}
// الدرر السنية: نص الحديث + الراوي + المحدّث + المصدر + الصفحة + خلاصة الحكم
async function dorar(q) {
  if (!q) return [];
  try {
    const j = await (await get('https://dorar.net/dorar_api.json?skey=' + encodeURIComponent(q))).json();
    const html = j.ahadith?.result || '';
    return html.split(/<div class="hadith"/).slice(1, 6).map((b) => {
      const t = strip(b), L = 'الراوي:|المحدث:|المصدر:|الصفحة أو الرقم:|خلاصة حكم المحدث:';
      const f = (k) => (t.match(new RegExp(k + ':\\s*(.*?)\\s*(?:' + L + '|$)')) || [])[1] || '';
      return { text: t.split('الراوي:')[0].trim(), narrator: f('الراوي'), muhaddith: f('المحدث'), source: f('المصدر'), page: f('الصفحة أو الرقم'), grade: f('خلاصة حكم المحدث') };
    }).filter((h) => h.text);
  } catch { return []; }
}
// التحقق من نص الآية من مصدر خارجي (رسم عثماني)
async function verifyAyah(ref) {
  const m = String(ref).match(/(\d{1,3})\s*[:：]\s*(\d{1,3})/);
  if (!m) return null;
  try { const j = await (await get(`https://api.alquran.cloud/v1/ayah/${m[1]}:${m[2]}/quran-uthmani`, 6000)).json(); return j.data ? j.data.text : null; }
  catch { return null; }
}
// المكتبة الشاملة: فتح صفحة الكتاب عند موضع الاستشهاد
app.get('/api/shamela', auth, lim(1, 20), async (req, res) => {
  const u = String(req.query.url || '');
  if (!/^https:\/\/(www\.)?shamela\.ws\//.test(u)) return res.status(400).json({ error: 'bad_url' });
  try {
    const h = await (await get(u)).text();
    const m = h.match(/<div class="nass[^>]*>([\s\S]*?)<\/div>/);
    res.json({ text: strip(m ? m[1] : h).slice(0, 3000) });
  } catch { res.status(502).json({ error: 'fetch_failed' }); }
});

// ---------- مكتبتك: بحث BM25 في الكتب المفهرسة (data/books.json) ----------
const norm = (s) => String(s).replace(/[\u064B-\u0652\u0640]/g, '').replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
const tok = (s) => norm(s).split(/[^\u0621-\u064A0-9]+/).filter((w) => w.length > 1);
let CH = [];
try { CH = JSON.parse(fs.readFileSync('data/books.json', 'utf8')).map((c) => ({ ...c, t: tok(c.text) })); } catch {}
const DF = new Map(); CH.forEach((c) => new Set(c.t).forEach((w) => DF.set(w, (DF.get(w) || 0) + 1)));
function searchBooks(q, k = 4) {
  const qs = [...new Set(tok(q))]; if (!CH.length || !qs.length) return [];
  return CH.map((c) => { const tf = new Map(); c.t.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1)); let s = 0;
    for (const w of qs) { const f = tf.get(w); if (f) s += Math.log(1 + CH.length / DF.get(w)) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * c.t.length / 250)); }
    return { c, s }; }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.c);
}
console.log(`Books index: ${CH.length} chunks`);

const SYS = `You are MIZAN (ميزان), an AI-supported scholarly verification assistant on Islamic content. Not a mufti, not a human scholar.
Reply ONLY with JSON in the user's chosen language (keep Arabic quotations of Quran/hadith in Arabic).
Content levels: A stable core facts -> direct sourced answer. B explanation/apologetics -> answer from approved material, avoid certainty where disputed. C fiqh disagreement/detailed aqeedah/controversial history -> restricted answer, state the disagreement, or refer. D personal fatwa/individual case/family dispute/legal-medical with sharia effect -> NO ruling; give general info only and refer to a qualified authority (e.g. Dar al-Ifta, Al-Azhar, local mufti).
Approved references: Quran (King Fahd Complex print; quranpedia.net), tafsir and history/aqeeda from first three centuries or dorar.net, hadith from the two Sahihs plus other Sunnah books ONLY with a verified grade (dorar.net/hadith, shamela.ws), fiqh from a book of one of the four madhhabs (dorar.net/feqhia), dawa.center and islamic-content.com for dawah topics and terminology.
Hard rules: never invent a verse, hadith, quote, ruling, volume or page. If unsure, leave the field null/empty and set confidence "insufficient" and recommend abstaining/referral. Separate scripture text from generated explanation. Never attribute a view to a person/institution unless certain. Do not present disputed matters as settled or claim consensus unless established. Give the Surah:Ayah for verses. If the user quotes a misquoted verse, correct it gently. If no authentic hadith matches, say so; never fabricate one. Hostile questions: do not mirror hostility, answer with wisdom and precision. Do not infer the user's religion or personal traits. Terms: keep Tawhid/Hadith/Sunnah/Fatwa/Da'wah with a short gloss rather than a flat translation.
Hadith: you receive RETRIEVED_HADITH (real data from dorar.net with grades). Never write hadith text yourself; set use_hadith to the indexes of the retrieved items that truly answer the question (empty array if none fit). Books: you also receive RETRIEVED_BOOKS (excerpts from the user's own library with book title and PDF page). Set use_books to the indexes whose excerpt genuinely supports the answer; never invent a page or quote. Mode "verify": split the user's text into independent claims; per claim give type (ayah|hadith|fatwa|fiqh_opinion|historical|attribution|contemporary), verdict (established|accepted|disputed|weak_evidence|needs_verification|misattributed|inaccurate|no_source_found) and a note.
JSON schema: {"level":"A|B|C|D","type":"historical|fiqh|fatwa|analysis|comparison|definition","summary":"","confidence":"high|medium|limited|insufficient","evidence":{"quran":[{"ref":"numeric surah:ayah e.g. 2:255","text":"","note":""}],"sunnah":[],"ijma":"","qiyas":""},"disagreement":{"exists":false,"views":[{"school_or_scholar":"","view":"","proof":""}]},"preponderant":{"view":"","reasons":"","who_says":""},"references":[{"work":"","author":"","volume_page":null,"edition":null,"hadith_grade":null,"url":null}],"use_hadith":[0],"use_books":[0],"claims":[],"assumptions":"","needs_referral":false,"referral_to":"","limits":""}`;

const abstain = (msg) => ({ level: 'C', type: 'analysis', summary: msg, confidence: 'insufficient', evidence: {}, disagreement: { exists: false, views: [] },
  preponderant: {}, references: [], claims: [], needs_referral: true, referral_to: '', limits: msg });

app.post('/api/chat', auth, lim(1, 12), async (req, res) => {
  const q = String(req.body.question || '').trim().slice(0, 4000);
  if (!q) return res.status(400).json({ error: 'empty' });
  const lang = String(req.body.lang || 'ar').slice(0, 5), mode = req.body.mode === 'verify' ? 'verify' : 'ask';
  const depth = ['quick', 'research', 'academic', 'teaching', 'fiqh_compare'].includes(req.body.depth) ? req.body.depth : 'research';
  if (!GEMINI_API_KEY) return res.json(abstain('GEMINI_API_KEY not configured.'));
  const hist = (Array.isArray(req.body.history) ? req.body.history : []).slice(-6)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: String(m.text || '').slice(0, 1500) }] }));
  const aq = await arabicQuery(q);
  const hs = await dorar(aq), bs = searchBooks(aq);
  const bctx = bs.map((b, i) => `[${i}] (${b.book}, PDF p.${b.page}) ${b.text.slice(0, 600)}`).join('\n') || '(none)';
  const ctx = hs.map((h, i) => `[${i}] ${h.text} | ${h.narrator} | ${h.muhaddith} | ${h.source} ${h.page} | ${h.grade}`).join('\n') || '(none)';
  const contents = [...hist, { role: 'user', parts: [{ text: `Language: ${lang}\nMode: ${mode}\nDepth: ${depth}\nRETRIEVED_HADITH:\n${ctx}\nRETRIEVED_BOOKS:\n${bctx}\nUser text:\n${q}` }] }];
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYS }] }, contents, generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }) });
    if (!r.ok) throw new Error(r.status);
    const raw = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const j = JSON.parse(raw.replace(/^```json|```$/g, '').trim());
    // حواجز السلامة بعد التوليد
    j.references = (j.references || []).map((x) => ({ ...x, url: x.url && okUrl(x.url) ? x.url : null }));
    if (j.level === 'D') j.needs_referral = true;
    const noSupport = !j.references.length && !(j.evidence?.quran?.length) && !(j.evidence?.sunnah?.length);
    if (noSupport && j.level !== 'D' && mode === 'ask') { j.confidence = 'insufficient'; j.needs_referral = true; }
    j.evidence = j.evidence || {};
    j.evidence.sunnah = (j.use_hadith || []).map((i) => hs[i]).filter(Boolean).map((h) => ({ text: h.text, source: [h.narrator, h.muhaddith, h.source, h.page].filter(Boolean).join(' — '), grade: h.grade }));
    for (const a of j.evidence.quran || []) { const t = await verifyAyah(a.ref); if (t) { a.text = t; a.verified = true; } else a.verified = false; }
    for (const i of j.use_books || []) { const b = bs[i]; if (b) j.references.push({ work: b.book, author: b.author, volume_page: 'PDF p.' + b.page, edition: null, hadith_grade: null, url: null, excerpt: b.text.slice(0, 500) }); }
    j.ai_notice = true;
    res.json(j);
  } catch { res.status(502).json(abstain('Upstream error — try again.')); }
});

app.get('/api/health', (_, r) => r.json({ ok: true }));
app.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((n) => n.family === 'IPv4' && !n.internal)?.address;
  console.log(`MIZAN AI  →  http://localhost:${PORT}   |   للموبايل (نفس الواي فاي): http://${lan}:${PORT}`);
  console.log(GEMINI_API_KEY ? 'Gemini key: loaded ✓' : 'Gemini key: MISSING ✗ (ضعه في .env)');
});
