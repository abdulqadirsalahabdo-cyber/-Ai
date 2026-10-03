import 'dotenv/config';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
const KEY = process.env.GEMINI_API_KEY, MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash', STEP = 4;
if (!KEY) { console.error('✗ Place GEMINI_API_KEY in .env'); process.exit(1); }
const META = { 'النبا_العظيم': { book: 'النبأ العظيم', author: 'محمد عبد الله دراز' } };
fs.mkdirSync('data', { recursive: true });
const PF = 'data/progress.json', prog = fs.existsSync(PF) ? JSON.parse(fs.readFileSync(PF, 'utf8')) : {};
const files = fs.existsSync('books') ? fs.readdirSync('books').filter((f) => f.toLowerCase().endsWith('.pdf')) : [];
if (!files.length) { console.error('✗ Place PDF files inside books/'); process.exit(1); }
// تنزيل وفهرسة النصوص آلياً عبر خوارزميات الاسترجاع والنصوص المرفقة.
