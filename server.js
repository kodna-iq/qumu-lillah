require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HASH_SALT = process.env.HASH_SALT || 'change-this-salt-in-env';

const ALLOWED_MIME = ['image/jpeg', 'image/png'];
const ALLOWED_EXT = ['.jpg', '.jpeg', '.png'];
const MAX_SIZE_MB = 20;
const MAX_FILES = 10;

const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');

// Trust Render/host reverse proxy so req.ip reflects the real visitor IP
app.set('trust proxy', true);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SUBMISSIONS_FILE)) fs.writeFileSync(SUBMISSIONS_FILE, '[]', 'utf8');

function loadSubmissions() {
  try {
    return JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveSubmissions(list) {
  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function hashValue(value) {
  return crypto.createHash('sha256').update(HASH_SALT + '::' + value).digest('hex');
}

function getClientIp(req) {
  // req.ip already respects X-Forwarded-For because trust proxy is enabled
  return (req.ip || '').replace('::ffff:', '');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIME.includes(file.mimetype) && ALLOWED_EXT.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('INVALID_FILE_TYPE'));
    }
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function escapeHtml(str = '') {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizePhone(phone) {
  return phone.replace(/[\s\-()]/g, '');
}

async function sendInfoMessage(fields) {
  const infoText =
    '📸 <b>طلب تقديم صورة جديد</b>\n\n' +
    '👤 <b>الاسم الكامل:</b> ' + escapeHtml(fields.fullName) + '\n' +
    '📞 <b>الهاتف:</b> ' + escapeHtml(fields.phone) + '\n' +
    '✉️ <b>البريد الإلكتروني:</b> ' + escapeHtml(fields.email) + '\n' +
    '📍 <b>المدينة/المحافظة:</b> ' + escapeHtml(fields.city) + '\n' +
    '🖼️ <b>عنوان الصورة:</b> ' + escapeHtml(fields.title) + '\n' +
    '📝 <b>الوصف:</b>\n' + escapeHtml(fields.description) + '\n\n' +
    '🗂️ <b>عدد الصور المرفقة:</b> ' + fields.fileCount;

  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: infoText, parse_mode: 'HTML' })
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.description || 'تعذّر إرسال بيانات الطلب إلى تلكرام');
}

async function sendPhotosToTelegram(files, title) {
  if (files.length === 1) {
    const fd = new FormData();
    fd.append('chat_id', CHAT_ID);
    fd.append('caption', title);
    fd.append('document', new Blob([files[0].buffer], { type: files[0].mimetype }), files[0].originalname);
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.description || 'تعذّر إرسال الصورة إلى تلكرام');
    return;
  }

  // Telegram sendMediaGroup accepts 2–10 items per call
  const chunks = [];
  for (let i = 0; i < files.length; i += 10) chunks.push(files.slice(i, i + 10));

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const media = chunk.map((f, i) => ({
      type: 'document',
      media: `attach://file${i}`,
      caption: (c === 0 && i === 0) ? title : undefined
    }));
    const fd = new FormData();
    fd.append('chat_id', CHAT_ID);
    fd.append('media', JSON.stringify(media));
    chunk.forEach((f, i) => {
      fd.append(`file${i}`, new Blob([f.buffer], { type: f.mimetype }), f.originalname);
    });
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, { method: 'POST', body: fd });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.description || 'تعذّر إرسال الصور إلى تلكرام');
  }
}

app.post('/api/submit', (req, res) => {
  upload.array('photos', MAX_FILES)(req, res, async (err) => {
    if (err) {
      if (err.message === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ ok: false, message: 'صيغة أحد الملفات غير مدعومة. الصيغ المسموحة: JPG, JPEG, PNG فقط.' });
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ ok: false, message: `حجم أحد الملفات كبير جداً. الحد الأقصى ${MAX_SIZE_MB} ميغابايت لكل صورة.` });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ ok: false, message: `الحد الأقصى ${MAX_FILES} صور في التقديم الواحد.` });
      }
      return res.status(400).json({ ok: false, message: 'تعذّر معالجة الملفات المرفوعة.' });
    }

    try {
      if (!BOT_TOKEN || !CHAT_ID) {
        return res.status(500).json({ ok: false, message: 'الخادم غير مُهيّأ بعد. يرجى ضبط بيانات بوت تلكرام في ملف .env' });
      }

      const { fullName, phone, email, city, title, description } = req.body;
      const files = req.files || [];

      if (!fullName || !phone || !email || !city || !title || !description || files.length === 0) {
        return res.status(400).json({ ok: false, message: 'يرجى تعبئة جميع الحقول ورفع صورة واحدة على الأقل.' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ ok: false, message: 'صيغة البريد الإلكتروني غير صحيحة.' });
      }

      // ---- One submission per person: check IP + email + phone ----
      const ip = getClientIp(req);
      const ipHash = hashValue(ip);
      const emailHash = hashValue(email.toLowerCase().trim());
      const phoneHash = hashValue(normalizePhone(phone));

      const submissions = loadSubmissions();
      const duplicate = submissions.find(
        s => s.ipHash === ipHash || s.emailHash === emailHash || s.phoneHash === phoneHash
      );
      if (duplicate) {
        return res.status(403).json({
          ok: false,
          message: 'لقد قمت بتقديم طلب مسبقاً من هذا الجهاز أو بهذه البيانات. يُسمح بتقديم واحد فقط لكل شخص.'
        });
      }

      // ---- Send to Telegram: one info message + all photos ----
      await sendInfoMessage({ fullName, phone, email, city, title, description, fileCount: files.length });
      await sendPhotosToTelegram(files, title);

      // ---- Record submission only after successful delivery ----
      submissions.push({ ipHash, emailHash, phoneHash, timestamp: Date.now() });
      saveSubmissions(submissions);

      return res.json({ ok: true, message: 'تم إرسال طلبك بنجاح. شكراً لمشاركتك عملك معنا.' });

    } catch (e) {
      console.error('Submission error:', e);
      return res.status(500).json({ ok: false, message: 'حدث خطأ أثناء إرسال الطلب. يرجى المحاولة لاحقاً.' });
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ الخادم يعمل على المنفذ ${PORT}`);
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('⚠️  تنبيه: لم يتم ضبط BOT_TOKEN أو CHAT_ID في ملف .env بعد');
  }
});
