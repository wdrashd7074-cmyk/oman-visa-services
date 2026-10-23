const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
const sessionSecret = required('SESSION_SECRET');
const adminUsername = required('ADMIN_USERNAME');
const adminPassword = required('ADMIN_PASSWORD');
const databaseUrl = required('DATABASE_URL');

if (isProduction && sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters in production.');
}
if (isProduction && adminPassword.length < 14) {
  throw new Error('Set a unique admin password of at least 14 characters in production.');
}
if (isProduction && process.env.DATABASE_SSL !== 'true') {
  console.warn('WARNING: DATABASE_SSL is not true. Confirm your database provider requires TLS.');
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false
});

app.disable('x-powered-by');
if (isProduction) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  }
}));
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  name: 'oman.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 4
  }
}));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { extensions: ['html'], maxAge: isProduction ? '1h' : 0 }));

const requestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة. يرجى الانتظار والمحاولة لاحقًا.' }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'تعذر تسجيل الدخول الآن. حاول لاحقًا.' }
});

const allowedServices = new Set([
  'استفسار عن متطلبات التأشيرة',
  'مساعدة في تجهيز الطلب',
  'مراجعة المستندات',
  'متابعة طلب قائم',
  'خدمة أخرى'
]);
const allowedPassport = new Set(['نعم', 'لا', 'أحتاج إلى معرفة المتطلبات']);
const allowedStatuses = new Set(['جديد', 'قيد المراجعة', 'بانتظار العميل', 'مكتمل', 'مغلق']);

function cleanString(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
function validPhone(value) {
  return /^[+\d][\d\s().-]{5,24}$/.test(value);
}
function requireAdmin(req, res, next) {
  if (!req.session || req.session.isAdmin !== true) {
    return res.status(401).json({ error: 'يلزم تسجيل الدخول.' });
  }
  next();
}
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  const expected = process.env.PUBLIC_ORIGIN;
  if (origin && expected && origin !== expected) {
    return res.status(403).json({ error: 'تم رفض الطلب.' });
  }
  next();
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id BIGSERIAL PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      full_name VARCHAR(120) NOT NULL,
      phone VARCHAR(30) NOT NULL,
      email VARCHAR(254),
      nationality VARCHAR(60) NOT NULL,
      service_type VARCHAR(80) NOT NULL,
      passport_validity VARCHAR(60) NOT NULL,
      details VARCHAR(1500),
      consent BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(40) NOT NULL DEFAULT 'جديد',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.post('/api/requests', requestLimiter, sameOrigin, async (req, res) => {
  const fullName = cleanString(req.body.fullName, 120);
  const phone = cleanString(req.body.phone, 30);
  const email = cleanString(req.body.email, 254).toLowerCase();
  const nationality = cleanString(req.body.nationality, 60);
  const serviceType = cleanString(req.body.serviceType, 80);
  const passportValidity = cleanString(req.body.passportValidity, 60);
  const details = cleanString(req.body.details, 1500);
  const consent = req.body.consent === true;

  if (fullName.length < 2 || !validPhone(phone) || nationality.length < 2 ||
      !allowedServices.has(serviceType) || !allowedPassport.has(passportValidity) ||
      !consent || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return res.status(400).json({ error: 'يرجى مراجعة الحقول المطلوبة والتأكد من صحتها.' });
  }

  const reference = 'OM-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  try {
    await pool.query(
      `INSERT INTO requests
       (reference, full_name, phone, email, nationality, service_type, passport_validity, details, consent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [reference, fullName, phone, email || null, nationality, serviceType, passportValidity, details || null, consent]
    );
    res.status(201).json({
      ok: true,
      reference,
      message: 'تم استلام الطلب مبدئيًا. احتفظ برقم المتابعة.'
    });
  } catch (err) {
    console.error('request insert failed', err.message);
    res.status(500).json({ error: 'تعذر حفظ الطلب حاليًا. يرجى المحاولة لاحقًا.' });
  }
});

app.post('/api/admin/login', loginLimiter, sameOrigin, async (req, res) => {
  const username = cleanString(req.body.username, 100);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  // Constant-time comparison avoids revealing which credential matched first.
  const suppliedUser = crypto.createHash('sha256').update(username).digest();
  const expectedUser = crypto.createHash('sha256').update(adminUsername).digest();
  const suppliedPass = crypto.createHash('sha256').update(password).digest();
  const expectedPass = crypto.createHash('sha256').update(adminPassword).digest();
  const userOk = crypto.timingSafeEqual(suppliedUser, expectedUser);
  const passOk = crypto.timingSafeEqual(suppliedPass, expectedPass);
  if (!userOk || !passOk) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'تعذر بدء الجلسة.' });
    req.session.isAdmin = true;
    req.session.adminUsername = adminUsername;
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'تعذر حفظ الجلسة.' });
      res.json({ ok: true });
    });
  });
});

app.post('/api/admin/logout', requireAdmin, sameOrigin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('oman.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax' });
    res.json({ ok: true });
  });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true, username: req.session.adminUsername }));

app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, reference, full_name, phone, email, nationality, service_type,
              passport_validity, details, status, created_at, updated_at
       FROM requests ORDER BY created_at DESC LIMIT 300`
    );
    res.json({ requests: result.rows });
  } catch (err) {
    console.error('request list failed', err.message);
    res.status(500).json({ error: 'تعذر جلب الطلبات.' });
  }
});

app.patch('/api/admin/requests/:id/status', requireAdmin, sameOrigin, async (req, res) => {
  const id = Number(req.params.id);
  const status = cleanString(req.body.status, 40);
  if (!Number.isSafeInteger(id) || id <= 0 || !allowedStatuses.has(status)) {
    return res.status(400).json({ error: 'بيانات الحالة غير صحيحة.' });
  }
  try {
    const result = await pool.query(
      'UPDATE requests SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING id, reference, status',
      [status, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'الطلب غير موجود.' });
    res.json({ ok: true, request: result.rows[0] });
  } catch (err) {
    console.error('status update failed', err.message);
    res.status(500).json({ error: 'تعذر تحديث الحالة.' });
  }
});

app.get('*path', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('unhandled error', err.message);
  res.status(500).json({ error: 'حدث خطأ غير متوقع.' });
});

initDb().then(() => {
  app.listen(port, () => console.log(`Oman Visa Services listening on ${port}`));
}).catch((err) => {
  console.error('Database initialization failed:', err.message);
  process.exit(1);
});
