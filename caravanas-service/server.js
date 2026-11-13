require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const mysql = require('mysql2/promise');
const multer = require('multer');
const Minio = require('minio');
const Stripe = require('stripe');

const app = express();

// Express 4 não captura erro de handler async; repassa ao tratador global.
for (const metodo of ['get', 'post', 'put', 'delete']) {
  const original = app[metodo].bind(app);
  app[metodo] = (rota, ...handlers) => {
    if (handlers.length === 0) return original(rota);
    const seguros = handlers.flat().map(h => (typeof h === 'function' && h.length < 4)
      ? (req, res, next) => {
          try {
            const r = h(req, res, next);
            if (r && typeof r.catch === 'function') r.catch(next);
          } catch (e) { next(e); }
        }
      : h);
    return original(rota, ...seguros);
  };
}

// ─── Regras do negócio (Caravana's Hub) ──────────────────────────────────────
const CIDADES_ALTA_PAULISTA = [
  'Adamantina', 'Bastos', 'Dracena', 'Flórida Paulista', 'Garça', 'Herculândia',
  'Inúbia Paulista', 'Junqueirópolis', 'Lucélia', 'Marília', 'Osvaldo Cruz',
  'Pacaembu', 'Parapuã', 'Pompeia', 'Quintana', 'Rinópolis', 'Tupã', 'Vera Cruz'
];
const TIPOS_EVENTO = ['futebol', 'corrida', 'mma'];
const ANTECEDENCIA_PRO_DIAS = Number(process.env.ANTECEDENCIA_PRO_DIAS) || 3;

// ─── API Futebol (substitui o TMDB) ──────────────────────────────────────────
const API_FUTEBOL_URL = 'https://api.api-futebol.com.br/v1';
const API_FUTEBOL_KEY = process.env.API_FUTEBOL_KEY || '';
const futebolApi = axios.create({
  baseURL: API_FUTEBOL_URL,
  timeout: 8000,
  headers: { Authorization: `Bearer ${API_FUTEBOL_KEY}` }
});

// ─── Stripe ───────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const stripe = Stripe(STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const APP_URL = process.env.APP_URL || '';

// ─── MinIO ────────────────────────────────────────────────────────────────────
const minioClient = new Minio.Client({
  endPoint:  process.env.MINIO_ENDPOINT || 'minio',
  port:      Number(process.env.MINIO_PORT) || 9000,
  useSSL:    false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'ademiro',
  secretKey: process.env.MINIO_SECRET_KEY || 'szoboslai'
});

const AVATAR_BUCKET   = 'avatars';
const CARAVANA_BUCKET = 'caravanas';
const BUCKETS = [AVATAR_BUCKET, CARAVANA_BUCKET];

async function garantirBucket(bucket) {
  const exists = await minioClient.bucketExists(bucket);
  if (exists) return;
  try {
    await minioClient.makeBucket(bucket, 'us-east-1');
  } catch (e) {
    if (e.code !== 'BucketAlreadyOwnedByYou' && e.code !== 'BucketAlreadyExists') throw e;
  }
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`] }]
  });
  await minioClient.setBucketPolicy(bucket, policy);
  console.log(`[MinIO] Bucket '${bucket}' criado e publicado.`);
}

async function garantirBuckets(tentativas = 20) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      for (const bucket of BUCKETS) await garantirBucket(bucket);
      return;
    } catch (e) {
      console.error(`[MinIO] Tentativa ${i}/${tentativas} de garantir buckets falhou:`, e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
garantirBuckets();

const EXT_POR_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp'
};
function mimeBase(file) {
  return String(file?.mimetype || '').split(';')[0].trim().toLowerCase();
}
function erroUpload(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!EXT_POR_MIME[mimeBase(file)]) return cb(erroUpload('Envie uma imagem JPG, PNG, WEBP, GIF, AVIF ou BMP.'));
    cb(null, true);
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      fontSrc:     ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
      imgSrc:      ["'self'", "https://cdn.api-futebol.com.br", "data:", "blob:", "https:"],
      connectSrc:  ["'self'"]
    }
  }
}));

// ─── Banco ────────────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 10
});

function agoraSP() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace('T', ' ');
}
function hojeSP() {
  return agoraSP().slice(0, 10);
}
function normalizarDataHora(v) {
  if (!v) return null;
  const s = String(v).trim().replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return `${s}:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 00:00:00`;
  return null;
}

// ─── Migração versionada: db/001_dominio.sql ─────────────────────────────────
function localizarMigracao() {
  const candidatos = [
    path.join(__dirname, 'db', '001_dominio.sql'),
    path.join(__dirname, '..', 'db', '001_dominio.sql')
  ];
  return candidatos.find(p => fs.existsSync(p));
}

function parseSqlStatements(rawSql) {
  const lines = rawSql.split(/\r?\n/).filter(l => !l.trim().startsWith('--'));
  const statements = [];
  let delimiter = ';';
  let buffer = '';

  for (const line of lines) {
    const m = line.trim().match(/^DELIMITER\s+(\S+)$/i);
    if (m) {
      delimiter = m[1];
      continue;
    }
    buffer += line + '\n';
    const trimmed = buffer.trim();
    if (trimmed.endsWith(delimiter)) {
      const stmt = trimmed.slice(0, -delimiter.length).trim();
      if (stmt) statements.push(stmt);
      buffer = '';
    }
  }
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}

async function migrarBanco() {
  const arquivo = localizarMigracao();
  if (!arquivo) {
    console.error('[DB] db/001_dominio.sql não encontrado. Migração não executada.');
    return;
  }
  const statements = parseSqlStatements(fs.readFileSync(arquivo, 'utf8'));
  let ok = 0;
  for (const st of statements) {
    try {
      await pool.query(st);
      ok++;
    } catch (err) {
      console.warn(`[DB] Aviso na migração (${err.code}): ${st.slice(0, 80)}...`, err.message);
    }
  }
  console.log(`[DB] Migração 001_dominio.sql: ${ok}/${statements.length} comandos aplicados.`);
}
migrarBanco().catch(e => console.error('[DB] Erro nas migrações:', e.message));

// ─── Auditoria ────────────────────────────────────────────────────────────────
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service-yago:3001';
const LOG_SERVICE_URL = process.env.LOG_SERVICE_URL || 'http://log-service-yago:3002';

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

async function registrarAuditoria(usuario_id, acao, detalhes = '', ip = '') {
  try {
    await axios.post(`${LOG_SERVICE_URL}/logs`, {
      usuario_id: String(usuario_id || 'anonimo'),
      acao,
      detalhes: String(detalhes || ''),
      ip: String(ip || '')
    }, { timeout: 3000 });
  } catch (error) {
    console.error('Erro ao enviar log para auditoria:', error.message);
  }
}

// ─── Pro e cupons ─────────────────────────────────────────────────────────────
async function gerarCupom(usuarioPremiumId, descontoPct, descricao, diasValidade = 90, caravanaId = null) {
  const codigo = `PRO-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const validade = new Date(Date.now() + diasValidade * 86400000).toISOString().slice(0, 10);
  await pool.query(
    'INSERT INTO cupons (codigo, descricao, desconto_percentual, caravana_id, usuario_premium_id, validade) VALUES (?, ?, ?, ?, ?, ?)',
    [codigo, descricao, descontoPct, caravanaId || null, usuarioPremiumId, validade]
  );
  return { codigo, desconto_percentual: descontoPct, validade };
}

async function ativarPro(contaId, customerId, origem, ip = '') {
  const [[antes]] = await pool.query('SELECT ativo FROM usuarios_premium WHERE conta_id = ?', [contaId]);
  const jaEraPro = Boolean(antes && antes.ativo == 1);
  await pool.query(
    `INSERT INTO usuarios_premium (conta_id, stripe_customer_id, ativo)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE
       stripe_customer_id = COALESCE(VALUES(stripe_customer_id), stripe_customer_id),
       ativo = 1`,
    [contaId, customerId || null]
  );
  if (!jaEraPro) await registrarAuditoria(contaId, 'upgrade_pro', `Assinatura Pro ativada (${origem})`, ip);
}

// ─── Passagem: pagamento único no Stripe Checkout (modo teste) ───────────────
const MINUTOS_PARA_PAGAR = 30;
const MINUTOS_SEGURANDO_ASSENTO = 32;

function agoraMaisMinutosSP(min) {
  return new Date(Date.now() + min * 60000)
    .toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace('T', ' ');
}

async function liberarReserva(reserva) {
  await pool.query('UPDATE reservas SET status_pagamento = "cancelado", expira_em = NULL WHERE id = ?', [reserva.id]);
  if (reserva.cupom_id) await pool.query('UPDATE cupons SET usado = 0 WHERE id = ?', [reserva.cupom_id]);
  await pool.query('UPDATE caravanas SET status = "aberta" WHERE id = ? AND status = "lotada"', [reserva.caravana_id]);
}

async function estornarPagamento(reserva, motivo, ip = '') {
  if (!reserva.stripe_payment_intent) return;
  await stripe.refunds.create({ payment_intent: reserva.stripe_payment_intent });
  const donoId = reserva.usuario_premium_id || reserva.usuario_free_id;
  await registrarAuditoria(donoId, 'pagamento_estornado',
    `Reserva #${reserva.id}: R$ ${Number(reserva.valor_total).toFixed(2)} estornado no Stripe (${motivo})`, ip);
}

async function expirarPendentes() {
  try {
    const [vencidas] = await pool.query(
      'SELECT * FROM reservas WHERE status_pagamento = "pendente" AND expira_em IS NOT NULL AND expira_em < ?', [agoraSP()]);
    for (const r of vencidas) {
      const [upd] = await pool.query('UPDATE reservas SET status_pagamento = "cancelado" WHERE id = ? AND status_pagamento = "pendente"', [r.id]);
      if (!upd.affectedRows) continue;
      await liberarReserva(r);
      const donoId = r.usuario_premium_id || r.usuario_free_id;
      await registrarAuditoria(donoId, 'reserva_expirada', `Reserva #${r.id} não foi paga em ${MINUTOS_PARA_PAGAR} min; vaga liberada`, '');
    }
  } catch (e) {
    console.error('[Reservas] Erro ao expirar pendentes:', e.message);
  }
}
setInterval(expirarPendentes, 2 * 60 * 1000);

async function confirmarReservaPaga(sess, ip = '') {
  const reservaId = Number(sess.metadata?.reserva_id);
  if (!reservaId || sess.metadata?.tipo !== 'passagem') return { ok: false, motivo: 'Sessão não é de passagem.' };
  if (sess.payment_status !== 'paid') return { ok: false, motivo: 'Pagamento ainda não aprovado.' };

  const [[r]] = await pool.query('SELECT * FROM reservas WHERE id = ?', [reservaId]);
  if (!r || r.stripe_session_id !== sess.id) return { ok: false, motivo: 'Reserva não confere com o pagamento.' };
  if (r.status_pagamento === 'pago') return { ok: true, reserva: r };

  const paymentIntent = typeof sess.payment_intent === 'string' ? sess.payment_intent : sess.payment_intent?.id;
  if (r.status_pagamento === 'cancelado') {
    await estornarPagamento({ ...r, stripe_payment_intent: paymentIntent }, 'pagamento após expirar', ip).catch(e =>
      console.error('[Stripe] Falha ao estornar pagamento tardio:', e.message));
    return { ok: false, motivo: 'O prazo da reserva acabou antes do pagamento. O valor foi estornado.' };
  }

  const [upd] = await pool.query(
    'UPDATE reservas SET status_pagamento = "pago", stripe_payment_intent = ?, expira_em = NULL WHERE id = ? AND status_pagamento = "pendente"',
    [paymentIntent || null, r.id]);
  const donoId = r.usuario_premium_id || r.usuario_free_id;
  if (upd.affectedRows) {
    await registrarAuditoria(donoId, 'vaga_reservada',
      `Reserva #${r.id} na caravana #${r.caravana_id} paga no Stripe (R$ ${Number(r.valor_total).toFixed(2)})`, ip);
    if (r.cupom_id) {
      await registrarAuditoria(donoId, 'cupom_aplicado',
        `Cupom #${r.cupom_id} usado na reserva #${r.id}: -R$ ${Number(r.desconto).toFixed(2)}`, ip);
    }
  }
  return { ok: true, reserva: { ...r, status_pagamento: 'pago' } };
}

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — Webhook (precisa do corpo bruto, por isso vem ANTES do express.json)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET) return res.status(503).send('Webhook desativado (STRIPE_WEBHOOK_SECRET ausente).');

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[Stripe Webhook] Assinatura inválida:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const sess = event.data.object;
        if (sess.mode === 'subscription') {
          const contaId = sess.client_reference_id || sess.metadata?.usuario_id;
          if (contaId) await ativarPro(contaId, sess.customer, 'webhook Stripe');
        } else if (sess.metadata?.tipo === 'passagem') {
          await confirmarReservaPaga(sess);
        }
      }

      if (event.type === 'customer.subscription.deleted') {
        const customerId = event.data.object.customer;
        await pool.query('UPDATE usuarios_premium SET ativo = 0 WHERE stripe_customer_id = ?', [customerId]);
        console.log(`[Stripe] Assinatura cancelada para customer ${customerId}.`);
      }
    } catch (e) {
      console.error('[Stripe Webhook] Erro ao processar evento:', e.message);
    }

    res.json({ received: true });
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionStore = new MySQLStore({}, pool);
app.use(session({
  key: 'session_cookie',
  secret: process.env.SESSION_SECRET || 'secret',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas. Tente novamente mais tarde.' }
});

// ─── Controle de acesso (RBAC, Padrão A: papel conferido no banco a cada chamada) ─
async function carregarUsuario(req, res, next) {
  if (!req.session.usuario) return res.status(401).json({ error: 'Faça login.' });
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.nome, c.email, c.papel, c.time_torcida, c.avatar_url,
             up.ativo AS pro_ativo, up.stripe_customer_id
        FROM contas c
        LEFT JOIN usuarios_premium up ON up.conta_id = c.id
       WHERE c.id = ?
    `, [req.session.usuario.id]);
    if (!rows.length) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
    }
    const u = rows[0];
    req.usuario = {
      id: u.id,
      nome: u.nome,
      email: u.email,
      papel: u.papel,
      role: u.papel,
      time_torcida: u.time_torcida,
      avatar_url: u.avatar_url,
      stripe_customer_id: u.stripe_customer_id,
      pro: u.papel === 'admin' || u.pro_ativo == 1
    };
    req.session.usuario.role = u.papel;
    req.session.usuario.papel = u.papel;
    req.session.usuario.premium = req.usuario.pro ? 1 : 0;
    next();
  } catch (err) {
    console.error('[RBAC] Erro ao carregar usuário:', err.message);
    res.status(500).json({ error: 'Erro ao validar sessão.' });
  }
}

function exigirPapel(...papeis) {
  return [carregarUsuario, async (req, res, next) => {
    if (papeis.includes(req.usuario.papel)) return next();
    await registrarAuditoria(
      req.usuario.id,
      'tentativa_negada_403',
      `Papel "${req.usuario.papel}" tentou [${req.method} ${req.originalUrl}] (exige: ${papeis.join(' ou ')})`,
      getClientIp(req)
    );
    return res.status(403).json({ error: `Acesso negado: ação permitida apenas para ${papeis.join(' ou ')}.` });
  }];
}

const autenticado = carregarUsuario;
const somenteAdmin = exigirPapel('admin');
const somenteOrganizador = exigirPapel('organizador', 'admin');

// --- ROTAS REPASSADAS AO AUTH-SERVICE VIA REDE INTERNA ---
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/register`, req.body, {
      headers: { 'x-forwarded-for': getClientIp(req) }
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro no serviço de autenticação' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/login`, req.body, {
      headers: { 'x-forwarded-for': getClientIp(req) }
    });
    req.session.usuario = response.data;
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Credenciais inválidas.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const usuario = req.session.usuario;
  if (usuario) {
    await registrarAuditoria(usuario.id, 'logout', `Sessão encerrada pelo usuário ${usuario.email}`, getClientIp(req));
  }
  req.session.destroy(() => {
    res.clearCookie('session_cookie');
    res.json({ message: 'Logout realizado.' });
  });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.usuario) return res.status(401).json({ error: 'Deslogado' });
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.nome, c.email, c.papel, c.time_torcida, c.avatar_url,
             up.ativo AS pro_ativo
        FROM contas c
        LEFT JOIN usuarios_premium up ON up.conta_id = c.id
       WHERE c.id = ?
    `, [req.session.usuario.id]);
    if (!rows.length) return res.status(401).json({ error: 'Deslogado' });
    const u = rows[0];
    req.session.usuario = {
      id: u.id, nome: u.nome, email: u.email,
      role: u.papel, papel: u.papel, time_torcida: u.time_torcida, avatar_url: u.avatar_url,
      premium: (u.papel === 'admin' || u.pro_ativo == 1) ? 1 : 0
    };
  } catch {}
  res.json({ ...req.session.usuario, antecedencia_pro_dias: ANTECEDENCIA_PRO_DIAS });
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const response = await axios.post(`${AUTH_SERVICE_URL}/forgot-password`, {
      email: req.body.email,
      baseUrl
    }, { headers: { 'x-forwarded-for': getClientIp(req) } });
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao solicitar recuperação.' });
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/reset-password`, req.body, {
      headers: { 'x-forwarded-for': getClientIp(req) }
    });
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao redefinir senha.' });
  }
});

app.post('/api/auth/change-password', autenticado, async (req, res) => {
  const { novaSenha } = req.body;
  if (!novaSenha || novaSenha.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
  }
  const ip = getClientIp(req);
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/change-password`, {
      usuario_id: req.usuario.id,
      novaSenha
    }, { headers: { 'x-forwarded-for': ip } });
    await registrarAuditoria(req.usuario.id, 'senha_alterada', 'Usuário alterou a própria senha', ip);
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao alterar senha.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — Assinatura Pro
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/stripe/config', (req, res) => {
  res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

function baseUrlDe(req) {
  if (APP_URL) return APP_URL;
  const referer = req.get('referer');
  if (referer) {
    try { return new URL(referer).origin; } catch {}
  }
  return `${req.protocol}://${req.get('host') || 'localhost:8228'}`;
}

app.post('/api/stripe/checkout', autenticado, async (req, res) => {
  try {
    const baseUrl = baseUrlDe(req);
    const line_items = STRIPE_PRICE_ID
      ? [{ price: STRIPE_PRICE_ID, quantity: 1 }]
      : [{
          price_data: {
            currency: 'brl',
            product_data: {
              name: "Caravana's Hub Pro",
              description: `Cupons de desconto, sorteio de brindes e acesso às caravanas ${ANTECEDENCIA_PRO_DIAS} dias antes`
            },
            unit_amount: 1990,
            recurring: { interval: 'month' }
          },
          quantity: 1
        }];

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items,
      customer_email: req.usuario.email || undefined,
      success_url: `${baseUrl}/app.html?pro=sucesso&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/app.html?pro=cancelado`,
      client_reference_id: String(req.usuario.id),
      metadata: { usuario_id: String(req.usuario.id), tipo: 'pro' }
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('[Stripe] Erro ao criar checkout:', err.message);
    res.status(500).json({ error: `Erro ao iniciar o checkout: ${err.message}` });
  }
});

app.get('/api/stripe/verify-session', autenticado, async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id obrigatório' });

  try {
    const sess = await stripe.checkout.sessions.retrieve(session_id);
    const dono = sess.client_reference_id || sess.metadata?.usuario_id;
    if (String(dono) !== String(req.usuario.id)) {
      return res.status(403).json({ error: 'Esta sessão de pagamento não pertence a você.' });
    }
    if (sess.mode !== 'subscription') {
      return res.status(400).json({ error: 'Esta sessão não é de assinatura Pro.' });
    }
    if (sess.status === 'complete') {
      await ativarPro(req.usuario.id, sess.customer, `checkout ${sess.id}`, getClientIp(req));
      return res.json({ success: true, premium: true });
    }
    res.json({ success: false, status: sess.status, payment_status: sess.payment_status });
  } catch (err) {
    console.error('[Stripe] Erro ao verificar sessão:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stripe/sincronizar', autenticado, async (req, res) => {
  try {
    const usuario = req.usuario;
    if (usuario.papel === 'admin') {
      return res.json({ success: true, premium: true, message: 'Administrador já tem todos os benefícios Pro.' });
    }

    let customerId = usuario.stripe_customer_id;
    if (!customerId && usuario.email) {
      try {
        const customers = await stripe.customers.list({ email: usuario.email.trim().toLowerCase(), limit: 1 });
        if (customers.data.length > 0) customerId = customers.data[0].id;
      } catch {}
    }

    let ativa = false;
    if (customerId) {
      try {
        const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
        ativa = subs.data.length > 0;
      } catch {}
    }

    if (ativa) {
      await ativarPro(usuario.id, customerId, 'sincronização manual', getClientIp(req));
      return res.json({ success: true, premium: true, message: 'Assinatura Pro reconhecida e ativa!' });
    }
    res.json({ success: false, premium: false, message: 'Nenhuma assinatura ativa encontrada no Stripe.' });
  } catch (err) {
    console.error('[Stripe] Erro ao sincronizar:', err.message);
    res.status(500).json({ error: 'Erro ao sincronizar: ' + err.message });
  }
});

app.post('/api/stripe/cancelar', autenticado, async (req, res) => {
  try {
    const usuario = req.usuario;
    const customerId = usuario.stripe_customer_id;

    let canceladas = 0;
    if (customerId) {
      try {
        const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active' });
        for (const sub of subs.data) {
          await stripe.subscriptions.cancel(sub.id);
          canceladas++;
        }
      } catch (subErr) {
        console.warn('[Stripe] Erro ao cancelar subscriptions:', subErr.message);
      }
    }

    await pool.query('UPDATE usuarios_premium SET ativo = 0 WHERE conta_id = ?', [usuario.id]);
    await registrarAuditoria(usuario.id, 'cancelar_pro', `Assinatura Pro cancelada (${canceladas} removidas no Stripe)`, getClientIp(req));
    res.json({ success: true, message: 'Assinatura Pro cancelada.' });
  } catch (err) {
    console.error('[Stripe] Erro ao cancelar:', err.message);
    res.status(500).json({ error: 'Erro ao cancelar assinatura: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MINIO — Avatar do usuário e foto da van/ônibus da caravana
// ─────────────────────────────────────────────────────────────────────────────
async function salvarImagem(bucket, prefixo, file) {
  const ext = EXT_POR_MIME[mimeBase(file)];
  const objectName = `${prefixo}_${Date.now()}.${ext}`;
  await garantirBucket(bucket);
  await minioClient.putObject(bucket, objectName, file.buffer, file.size, { 'Content-Type': mimeBase(file) });
  return { objectName, url: `/api/storage/${bucket}/${objectName}` };
}

app.post('/api/perfil/avatar', autenticado, uploadImage.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const maxSize = req.usuario.pro ? 10 * 1024 * 1024 : 2 * 1024 * 1024;
    if (req.file.size > maxSize) {
      return res.status(400).json({ error: req.usuario.pro ? 'Máximo 10 MB.' : 'Máximo 2 MB no plano Free.' });
    }
    const { objectName, url } = await salvarImagem(AVATAR_BUCKET, `avatar_${req.usuario.id}`, req.file);
    await pool.query('UPDATE contas SET avatar_url = ? WHERE id = ?', [url, req.usuario.id]);
    await registrarAuditoria(req.usuario.id, 'upload_avatar', `Avatar salvo no MinIO: ${objectName}`, getClientIp(req));
    res.json({ url });
  } catch (err) {
    console.error('[MinIO] Erro upload avatar:', err);
    res.status(500).json({ error: 'Erro ao fazer upload do avatar.' });
  }
});

app.get('/api/storage/:bucket/:objectName', async (req, res) => {
  try {
    const { bucket, objectName } = req.params;
    if (!BUCKETS.includes(bucket)) return res.status(403).json({ error: 'Bucket inválido.' });

    const stat = await minioClient.statObject(bucket, objectName);
    res.setHeader('Content-Type', stat.metaData['content-type'] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    const stream = await minioClient.getObject(bucket, objectName);
    stream.on('error', (e) => {
      console.error('[Storage Proxy] Erro no stream:', e.message);
      res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    res.status(404).json({ error: 'Mídia não encontrada.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CARAVANAS — recurso principal (CRUD)
// ─────────────────────────────────────────────────────────────────────────────
function arred(v) { return Math.round(Number(v) * 100) / 100; }

function aberturaPro(aberturaGeral) {
  const d = new Date(String(aberturaGeral).replace(' ', 'T') + 'Z');
  d.setUTCDate(d.getUTCDate() - ANTECEDENCIA_PRO_DIAS);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const SELECT_CARAVANA = `
  SELECT c.*, e.tipo AS evento_tipo, e.nome AS evento_nome, e.local AS evento_local, e.pais AS evento_pais,
         e.data_evento, e.valor_ingresso, e.escudo_mandante, e.escudo_visitante,
         ct.nome AS organizador_nome, o.descricao_frota, o.contato_whatsapp,
         (SELECT COUNT(*) FROM reservas r WHERE r.caravana_id = c.id AND r.status_pagamento <> 'cancelado') AS ocupados
    FROM caravanas c
    JOIN eventos e       ON e.id = c.evento_id
    JOIN organizadores o ON o.conta_id = c.organizador_id
    JOIN contas ct       ON ct.id = o.conta_id`;

function montarCaravana(row) {
  const abertura_pro_em = aberturaPro(row.abertura_vendas_em);
  const agora = agoraSP();
  const ocupados = Number(row.ocupados || 0);
  return {
    ...row,
    ocupados,
    vagas_livres: Math.max(0, Number(row.vagas_totais) - ocupados),
    abertura_pro_em,
    exclusiva_pro_agora: abertura_pro_em <= agora && row.abertura_vendas_em > agora
  };
}

function visivelPara(row, usuario) {
  if (usuario.papel === 'admin') return true;
  if (usuario.papel === 'organizador' && row.organizador_id === usuario.id) return true;
  if (row.status === 'cancelada') return false;
  const agora = agoraSP();
  const abertura = usuario.pro ? aberturaPro(row.abertura_vendas_em) : row.abertura_vendas_em;
  return abertura <= agora;
}

app.get('/api/caravanas', autenticado, async (req, res) => {
  try {
    const params = [];
    let where = ' WHERE 1=1';
    if (req.query.tipo && TIPOS_EVENTO.includes(req.query.tipo)) {
      where += ' AND e.tipo = ?';
      params.push(req.query.tipo);
    }
    if (req.query.cidade) {
      where += ' AND c.cidade_saida = ?';
      params.push(req.query.cidade);
    }
    if (req.usuario.papel === 'passageiro') {
      where += ' AND c.data_saida > ?';
      params.push(agoraSP());
    }
    const [rows] = await pool.query(`${SELECT_CARAVANA}${where} ORDER BY c.data_saida`, params);

    const visiveis = rows.filter(r => visivelPara(r, req.usuario));
    const exclusivasPro = req.usuario.pro ? 0 : rows.filter(r =>
      r.status !== 'cancelada' && !visivelPara(r, req.usuario) && aberturaPro(r.abertura_vendas_em) <= agoraSP()
    ).length;

    res.json({
      caravanas: visiveis.map(montarCaravana),
      exclusivas_pro_ocultas: exclusivasPro,
      antecedencia_pro_dias: ANTECEDENCIA_PRO_DIAS
    });
  } catch (err) {
    console.error('[Caravanas] Erro ao listar:', err);
    res.status(500).json({ error: 'Erro ao listar caravanas.' });
  }
});

app.get('/api/caravanas/:id', autenticado, async (req, res) => {
  try {
    const [rows] = await pool.query(`${SELECT_CARAVANA} WHERE c.id = ?`, [req.params.id]);
    if (!rows.length || !visivelPara(rows[0], req.usuario)) {
      return res.status(404).json({ error: 'Caravana não encontrada.' });
    }
    res.json(montarCaravana(rows[0]));
  } catch (err) {
    console.error('[Caravanas] Erro ao detalhar:', err);
    res.status(500).json({ error: 'Erro ao buscar caravana.' });
  }
});

async function validarCaravana(body, usuario, atual = {}) {
  const d = { ...atual, ...body };
  const erros = [];
  const organizadorId = usuario.papel === 'admin' && d.organizador_id
    ? Number(d.organizador_id)
    : (atual.organizador_id || usuario.id);

  const out = {
    evento_id: Number(d.evento_id),
    organizador_id: organizadorId,
    vagas_totais: Number(d.vagas_totais),
    preco: Number(d.preco),
    data_saida: normalizarDataHora(d.data_saida),
    local_saida: String(d.local_saida || '').trim(),
    cidade_saida: String(d.cidade_saida || '').trim(),
    abertura_vendas_em: normalizarDataHora(d.abertura_vendas_em) || agoraSP(),
    status: d.status || 'aberta'
  };

  if (!CIDADES_ALTA_PAULISTA.includes(out.cidade_saida)) erros.push('Cidade de saída precisa ser da Alta Paulista.');
  if (!out.local_saida) erros.push('Informe o local de saída.');
  if (!out.data_saida) erros.push('Data de saída inválida.');
  if (!(Number.isInteger(out.vagas_totais) && out.vagas_totais >= 1 && out.vagas_totais <= 60)) erros.push('Vagas entre 1 e 60.');
  if (!(out.preco > 0)) erros.push('Preço deve ser maior que zero.');
  if (!['aberta', 'lotada', 'cancelada', 'concluida'].includes(out.status)) erros.push('Status inválido.');

  const [[evento]] = await pool.query('SELECT id FROM eventos WHERE id = ?', [out.evento_id]);
  if (!evento) erros.push('Evento não encontrado.');

  // Garante que o organizador exista na tabela organizadores
  await pool.query('INSERT IGNORE INTO organizadores (conta_id) VALUES (?)', [out.organizador_id]);
  return { dados: out, erros };
}

app.post('/api/caravanas', somenteOrganizador, async (req, res) => {
  try {
    const { dados, erros } = await validarCaravana(req.body, req.usuario);
    if (erros.length) return res.status(400).json({ error: erros.join(' ') });

    const [result] = await pool.query(
      `INSERT INTO caravanas (evento_id, organizador_id, vagas_totais, preco, data_saida, local_saida, cidade_saida, abertura_vendas_em, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [dados.evento_id, dados.organizador_id, dados.vagas_totais, dados.preco, dados.data_saida,
       dados.local_saida, dados.cidade_saida, dados.abertura_vendas_em, dados.status]
    );
    await registrarAuditoria(req.usuario.id, 'caravana_criada',
      `Caravana #${result.insertId} saindo de ${dados.cidade_saida} (evento #${dados.evento_id})`, getClientIp(req));
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error('[Caravanas] Erro ao criar:', err);
    res.status(500).json({ error: 'Erro ao criar caravana.' });
  }
});

async function cancelarCaravanaComEstorno(caravanaId, ip) {
  await pool.query('UPDATE caravanas SET status = "cancelada" WHERE id = ?', [caravanaId]);
  const [ativas] = await pool.query(
    'SELECT * FROM reservas WHERE caravana_id = ? AND status_pagamento <> "cancelado"', [caravanaId]);
  let estornadas = 0, falhas = 0;
  for (const r of ativas) {
    try {
      if (r.status_pagamento === 'pago') {
        await estornarPagamento(r, `caravana #${caravanaId} cancelada`, ip);
        if (r.stripe_payment_intent) estornadas++;
      } else if (r.status_pagamento === 'pendente' && r.stripe_session_id) {
        await stripe.checkout.sessions.expire(r.stripe_session_id).catch(() => {});
      }
      await liberarReserva(r);
    } catch (e) {
      falhas++;
      console.error(`[Stripe] Falha ao estornar reserva #${r.id}:`, e.message);
    }
  }
  return { total: ativas.length, estornadas, falhas };
}

app.put('/api/caravanas/:id', somenteOrganizador, async (req, res) => {
  try {
    const [[atual]] = await pool.query('SELECT * FROM caravanas WHERE id = ?', [req.params.id]);
    if (!atual) return res.status(404).json({ error: 'Caravana não encontrada.' });
    if (req.usuario.papel !== 'admin' && atual.organizador_id !== req.usuario.id) {
      await registrarAuditoria(req.usuario.id, 'tentativa_negada_403',
        `Tentou editar caravana #${req.params.id} de outro organizador`, getClientIp(req));
      return res.status(403).json({ error: 'Você só pode editar as suas próprias caravanas.' });
    }

    const { dados, erros } = await validarCaravana(req.body, req.usuario, atual);
    if (erros.length) return res.status(400).json({ error: erros.join(' ') });

    await pool.query(
      `UPDATE caravanas SET evento_id=?, organizador_id=?, vagas_totais=?, preco=?, data_saida=?,
         local_saida=?, cidade_saida=?, abertura_vendas_em=?, status=? WHERE id = ?`,
      [dados.evento_id, dados.organizador_id, dados.vagas_totais, dados.preco, dados.data_saida,
       dados.local_saida, dados.cidade_saida, dados.abertura_vendas_em, dados.status, req.params.id]
    );
    const acao = dados.status === 'cancelada' && atual.status !== 'cancelada' ? 'caravana_cancelada' : 'caravana_editada';
    let extra = '';
    if (acao === 'caravana_cancelada') {
      const r = await cancelarCaravanaComEstorno(atual.id, getClientIp(req));
      extra = `, ${r.total} reserva(s) cancelada(s), ${r.estornadas} estorno(s)`;
    }
    await registrarAuditoria(req.usuario.id, acao, `Caravana #${req.params.id} (${dados.cidade_saida}, status ${dados.status}${extra})`, getClientIp(req));
    res.json({ message: `Caravana atualizada${extra}.` });
  } catch (err) {
    console.error('[Caravanas] Erro ao editar:', err);
    res.status(500).json({ error: 'Erro ao editar caravana.' });
  }
});

app.delete('/api/caravanas/:id', somenteOrganizador, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const [[atual]] = await pool.query('SELECT id, organizador_id, cidade_saida FROM caravanas WHERE id = ?', [req.params.id]);
    if (!atual) return res.status(404).json({ error: 'Caravana não encontrada.' });
    if (req.usuario.papel !== 'admin' && atual.organizador_id !== req.usuario.id) {
      await registrarAuditoria(req.usuario.id, 'tentativa_negada_403',
        `Tentou remover caravana #${req.params.id} de outro organizador`, ip);
      return res.status(403).json({ error: 'Você só pode remover as suas próprias caravanas.' });
    }

    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM reservas WHERE caravana_id = ?', [req.params.id]);
    if (Number(total) > 0) {
      const r = await cancelarCaravanaComEstorno(atual.id, ip);
      await registrarAuditoria(req.usuario.id, 'caravana_cancelada',
        `Caravana #${atual.id} (${atual.cidade_saida}) cancelada: ${r.total} reserva(s), ${r.estornadas} estorno(s)`, ip);
      return res.json({ message: `Caravana cancelada. ${r.total} reserva(s) cancelada(s), ${r.estornadas} estorno(s) no Stripe.` });
    }

    await pool.query('DELETE FROM caravanas WHERE id = ?', [req.params.id]);
    await registrarAuditoria(req.usuario.id, 'caravana_removida', `Caravana #${req.params.id} (${atual.cidade_saida}) removida`, ip);
    res.json({ message: 'Caravana removida.' });
  } catch (err) {
    console.error('[Caravanas] Erro ao remover:', err);
    res.status(500).json({ error: 'Erro ao remover caravana.' });
  }
});

// Upload da foto da van/ônibus da caravana (MinIO)
app.post('/api/caravanas/:id/foto', somenteOrganizador, uploadImage.single('foto'), async (req, res) => {
  try {
    const [[caravana]] = await pool.query('SELECT id, organizador_id FROM caravanas WHERE id = ?', [req.params.id]);
    if (!caravana) return res.status(404).json({ error: 'Caravana não encontrada.' });
    if (req.usuario.papel !== 'admin' && caravana.organizador_id !== req.usuario.id) {
      await registrarAuditoria(req.usuario.id, 'tentativa_negada_403', `Tentou subir foto na caravana #${req.params.id} de outro organizador`, getClientIp(req));
      return res.status(403).json({ error: 'Você só pode alterar suas próprias caravanas.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const { objectName, url } = await salvarImagem(CARAVANA_BUCKET, `caravana_${caravana.id}`, req.file);
    await pool.query('UPDATE caravanas SET foto_url = ? WHERE id = ?', [url, caravana.id]);
    await registrarAuditoria(req.usuario.id, 'foto_caravana_enviada', `Foto da caravana #${caravana.id} salva no MinIO: ${objectName}`, getClientIp(req));
    res.json({ url });
  } catch (err) {
    console.error('[MinIO] Erro upload foto caravana:', err);
    res.status(500).json({ error: 'Erro ao enviar foto da caravana.' });
  }
});

app.get('/api/meta', autenticado, (req, res) => {
  res.json({ cidades: CIDADES_ALTA_PAULISTA, tipos: TIPOS_EVENTO, antecedencia_pro_dias: ANTECEDENCIA_PRO_DIAS });
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENTOS (jogo, corrida, luta)
// Regra RBAC: só admin cadastra corrida (F1). Trigger SQL garante 1 corrida/ano no Brasil.
// ─────────────────────────────────────────────────────────────────────────────
function validarEvento(d) {
  const erros = [];
  const out = {
    tipo: d.tipo,
    nome: String(d.nome || '').trim(),
    local: String(d.local || '').trim(),
    pais: String(d.pais || 'Brasil').trim(),
    data_evento: String(d.data_evento || '').slice(0, 10),
    valor_ingresso: Number(d.valor_ingresso || 0)
  };
  if (!TIPOS_EVENTO.includes(out.tipo)) erros.push('Tipo deve ser futebol, corrida ou mma.');
  if (!out.nome) erros.push('Informe o nome do evento.');
  if (!out.local) erros.push('Informe o local.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.data_evento)) erros.push('Data do evento inválida (YYYY-MM-DD).');
  if (!(out.valor_ingresso >= 0)) erros.push('Valor do ingresso inválido.');
  return { dados: out, erros };
}

app.get('/api/eventos', autenticado, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM eventos ORDER BY data_evento');
  res.json(rows);
});

app.post('/api/eventos', somenteOrganizador, async (req, res) => {
  const { dados, erros } = validarEvento(req.body);
  if (erros.length) return res.status(400).json({ error: erros.join(' ') });

  if (dados.tipo === 'corrida' && req.usuario.papel !== 'admin') {
    await registrarAuditoria(req.usuario.id, 'tentativa_negada_403', 'Organizador tentou cadastrar corrida de F1 (restrito a admin)', getClientIp(req));
    return res.status(403).json({ error: 'Apenas administradores podem cadastrar corridas de Fórmula 1.' });
  }

  try {
    const [r] = await pool.query(
      'INSERT INTO eventos (tipo, nome, local, pais, data_evento, criado_por, valor_ingresso) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [dados.tipo, dados.nome, dados.local, dados.pais, dados.data_evento, req.usuario.id, dados.valor_ingresso]
    );
    await registrarAuditoria(req.usuario.id, 'evento_criado', `Evento #${r.insertId} (${dados.tipo}): ${dados.nome}`, getClientIp(req));
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.sqlState === '45000' || err.errno === 1644) {
      return res.status(409).json({ error: err.sqlMessage });
    }
    throw err;
  }
});

app.put('/api/eventos/:id', somenteAdmin, async (req, res) => {
  const [[atual]] = await pool.query('SELECT * FROM eventos WHERE id = ?', [req.params.id]);
  if (!atual) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { dados, erros } = validarEvento({ ...atual, ...req.body });
  if (erros.length) return res.status(400).json({ error: erros.join(' ') });
  await pool.query(
    'UPDATE eventos SET tipo=?, nome=?, local=?, pais=?, data_evento=?, valor_ingresso=? WHERE id = ?',
    [dados.tipo, dados.nome, dados.local, dados.pais, dados.data_evento, dados.valor_ingresso, req.params.id]
  );
  await registrarAuditoria(req.usuario.id, 'evento_editado', `Evento #${req.params.id}: ${dados.nome}`, getClientIp(req));
  res.json({ message: 'Evento atualizado.' });
});

app.delete('/api/eventos/:id', somenteAdmin, async (req, res) => {
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM caravanas WHERE evento_id = ?', [req.params.id]);
  if (Number(total) > 0) return res.status(409).json({ error: 'Existem caravanas para este evento. Remova-as primeiro.' });
  const [r] = await pool.query('DELETE FROM eventos WHERE id = ?', [req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Evento não encontrado.' });
  await registrarAuditoria(req.usuario.id, 'evento_removido', `Evento #${req.params.id}`, getClientIp(req));
  res.json({ message: 'Evento removido.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// API FUTEBOL — importar jogos reais como eventos
// ─────────────────────────────────────────────────────────────────────────────
function mapearPartida(p) {
  return {
    partida_id: p.partida_id,
    campeonato: p.campeonato?.nome || '',
    mandante: p.time_mandante?.nome_popular,
    visitante: p.time_visitante?.nome_popular,
    escudo_mandante: p.time_mandante?.escudo || null,
    escudo_visitante: p.time_visitante?.escudo || null,
    data_iso: p.data_realizacao_iso || null,
    estadio: p.estadio?.nome_popular || null,
    status: p.status
  };
}

app.get('/api/futebol/campeonatos', somenteOrganizador, async (req, res) => {
  try {
    const { data } = await futebolApi.get('/campeonatos');
    res.json(data.map(c => ({
      campeonato_id: c.campeonato_id, nome: c.nome_popular || c.nome,
      rodada_atual: c.rodada_atual?.rodada || null, logo: c.logo
    })));
  } catch (err) {
    console.error('[API Futebol] campeonatos:', err.response?.status, err.message);
    res.status(502).json({ error: 'Não foi possível consultar a API Futebol.' });
  }
});

app.get('/api/futebol/partidas', somenteOrganizador, async (req, res) => {
  try {
    const campeonato = Number(req.query.campeonato) || 10;
    let rodada = Number(req.query.rodada);
    if (!rodada) {
      const { data: camp } = await futebolApi.get(`/campeonatos/${campeonato}`);
      rodada = camp.rodada_atual?.rodada || 1;
    }
    const { data } = await futebolApi.get(`/campeonatos/${campeonato}/rodadas/${rodada}`);
    res.json({ rodada, nome: data.nome, partidas: (data.partidas || []).map(mapearPartida) });
  } catch (err) {
    console.error('[API Futebol] partidas:', err.response?.status, err.message);
    res.status(502).json({ error: 'Não foi possível consultar a API Futebol.' });
  }
});

app.post('/api/futebol/importar', somenteOrganizador, async (req, res) => {
  const partidaId = Number(req.body.partida_id);
  if (!partidaId) return res.status(400).json({ error: 'partida_id obrigatório.' });
  try {
    const { data } = await futebolApi.get(`/partidas/${partidaId}`);
    const p = mapearPartida(data);
    const dataEvento = p.data_iso ? p.data_iso.slice(0, 10) : (String(req.body.data_evento || '').slice(0, 10) || hojeSP());

    const [r] = await pool.query(
      `INSERT INTO eventos (tipo, nome, local, pais, data_evento, criado_por, valor_ingresso, api_partida_id, escudo_mandante, escudo_visitante)
       VALUES ('futebol', ?, ?, 'Brasil', ?, ?, ?, ?, ?, ?)`,
      [`${p.mandante} x ${p.visitante}`, p.estadio || String(req.body.local || 'Estádio a definir').trim(),
       dataEvento, req.usuario.id, Number(req.body.valor_ingresso) || 0,
       partidaId, p.escudo_mandante, p.escudo_visitante]
    );
    await registrarAuditoria(req.usuario.id, 'evento_importado_api',
      `Partida ${partidaId} (${p.mandante} x ${p.visitante}) importada da API Futebol como evento #${r.insertId}`, getClientIp(req));
    res.status(201).json({ id: r.insertId, nome: `${p.mandante} x ${p.visitante}` });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Essa partida já foi importada.' });
    console.error('[API Futebol] importar:', err.response?.status, err.message);
    res.status(502).json({ error: 'Não foi possível importar a partida da API Futebol.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RESERVAS (passageiro free OU premium). Cada usuário só vê e altera as próprias.
// ─────────────────────────────────────────────────────────────────────────────
const SELECT_RESERVA = `
  SELECT r.*, c.cidade_saida, c.local_saida, c.data_saida, c.status AS caravana_status, c.preco AS caravana_preco,
         e.nome AS evento_nome, e.tipo AS evento_tipo, e.local AS evento_local, e.data_evento,
         e.valor_ingresso, e.escudo_mandante, e.escudo_visitante,
         cp.codigo AS cupom_codigo,
         COALESCE(r.usuario_premium_id, r.usuario_free_id) AS dono_id,
         u.nome AS passageiro_nome, u.email AS passageiro_email
    FROM reservas r
    JOIN caravanas c ON c.id = r.caravana_id
    JOIN eventos e   ON e.id = c.evento_id
    JOIN contas u    ON u.id = COALESCE(r.usuario_premium_id, r.usuario_free_id)
    LEFT JOIN cupons cp ON cp.id = r.cupom_id`;

app.get('/api/reservas', autenticado, async (req, res) => {
  try {
    const todas = req.usuario.papel === 'admin' && req.query.todas === '1';
    const [rows] = todas
      ? await pool.query(`${SELECT_RESERVA} ORDER BY r.criado_em DESC LIMIT 300`)
      : await pool.query(`${SELECT_RESERVA} WHERE r.usuario_free_id = ? OR r.usuario_premium_id = ? ORDER BY c.data_saida DESC`,
          [req.usuario.id, req.usuario.id]);
    res.json(rows);
  } catch (err) {
    console.error('[Reservas] Erro ao listar:', err);
    res.status(500).json({ error: 'Erro ao listar reservas.' });
  }
});

app.get('/api/reservas/:id', autenticado, async (req, res) => {
  try {
    const [rows] = await pool.query(`${SELECT_RESERVA} WHERE r.id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Reserva não encontrada.' });
    const reserva = rows[0];

    if (reserva.dono_id !== req.usuario.id && req.usuario.papel !== 'admin') {
      await registrarAuditoria(req.usuario.id, 'tentativa_acesso_reserva_alheia',
        `Tentou abrir a reserva #${req.params.id}, que pertence à conta #${reserva.dono_id}`, getClientIp(req));
      return res.status(403).json({ error: 'Esta reserva pertence a outro passageiro.' });
    }
    res.json(reserva);
  } catch (err) {
    console.error('[Reservas] Erro ao detalhar:', err);
    res.status(500).json({ error: 'Erro ao buscar reserva.' });
  }
});

app.post('/api/reservas', autenticado, async (req, res) => {
  const ip = getClientIp(req);
  const caravanaId = Number(req.body.caravana_id);
  const codigoCupom = String(req.body.cupom || '').trim().toUpperCase();
  if (!caravanaId) return res.status(400).json({ error: 'caravana_id obrigatório.' });

  await expirarPendentes();

  // Garante existência nas tabelas tipadas conforme o plano atual
  if (req.usuario.pro) {
    await pool.query('INSERT IGNORE INTO usuarios_premium (conta_id, ativo) VALUES (?, 1)', [req.usuario.id]);
  } else {
    await pool.query('INSERT IGNORE INTO usuarios_free (conta_id) VALUES (?)', [req.usuario.id]);
  }

  const conn = await pool.getConnection();
  let reservaCriada = null;
  try {
    await conn.beginTransaction();

    const [[trava]] = await conn.query('SELECT id FROM caravanas WHERE id = ? FOR UPDATE', [caravanaId]);
    const [rows] = trava ? await conn.query(`${SELECT_CARAVANA} WHERE c.id = ?`, [caravanaId]) : [[]];
    const caravana = rows[0];
    if (!caravana || !visivelPara(caravana, req.usuario)) {
      await conn.rollback();
      return res.status(404).json({ error: 'Caravana não encontrada.' });
    }
    if (caravana.status !== 'aberta') {
      await conn.rollback();
      return res.status(409).json({ error: `Caravana ${caravana.status}. Não é possível reservar.` });
    }
    if (caravana.data_saida <= agoraSP()) {
      await conn.rollback();
      return res.status(409).json({ error: 'Essa caravana já saiu.' });
    }

    const [[ja]] = await conn.query(
      `SELECT id, status_pagamento FROM reservas
        WHERE caravana_id = ? AND (usuario_free_id = ? OR usuario_premium_id = ?) AND status_pagamento <> "cancelado"`,
      [caravanaId, req.usuario.id, req.usuario.id]);
    if (ja) {
      await conn.rollback();
      return res.status(409).json({
        error: ja.status_pagamento === 'pendente'
          ? 'Você já tem uma reserva aguardando pagamento nesta caravana. Abra "Minhas passagens" para pagar.'
          : 'Você já tem uma passagem nesta caravana.',
        reserva_id: ja.id
      });
    }

    const [[{ ocupados }]] = await conn.query(
      'SELECT COUNT(*) AS ocupados FROM reservas WHERE caravana_id = ? AND status_pagamento <> "cancelado"', [caravanaId]);
    if (Number(ocupados) >= Number(caravana.vagas_totais)) {
      await conn.query('UPDATE caravanas SET status = "lotada" WHERE id = ?', [caravanaId]);
      await conn.commit();
      return res.status(409).json({ error: 'Caravana lotada.' });
    }

    const precoBase = Number(caravana.preco);
    const ingresso = Number(caravana.valor_ingresso || 0);
    const parteViagem = Math.max(0, precoBase - ingresso);
    let desconto = 0;
    let cupom = null;
    if (codigoCupom) {
      if (!req.usuario.pro) {
        await conn.rollback();
        return res.status(403).json({ error: 'Cupons são um benefício exclusivo de assinantes Premium/Pro.' });
      }
      const [[c]] = await conn.query('SELECT * FROM cupons WHERE codigo = ? FOR UPDATE', [codigoCupom]);
      if (!c || c.usuario_premium_id !== req.usuario.id) {
        await conn.rollback();
        return res.status(404).json({ error: 'Cupom não encontrado.' });
      }
      if (c.caravana_id && c.caravana_id !== caravanaId) {
        await conn.rollback();
        return res.status(409).json({ error: 'Este cupom não vale para esta caravana.' });
      }
      if (c.usado) { await conn.rollback(); return res.status(409).json({ error: 'Cupom já utilizado.' }); }
      if (c.validade < hojeSP()) { await conn.rollback(); return res.status(409).json({ error: 'Cupom vencido.' }); }
      desconto = arred((parteViagem > 0 ? parteViagem : precoBase) * Number(c.desconto_percentual) / 100);
      cupom = c;
      await conn.query('UPDATE cupons SET usado = 1 WHERE id = ?', [c.id]);
    }

    const total = Math.max(1, arred(precoBase - desconto));
    const freeId = req.usuario.pro ? null : req.usuario.id;
    const premId = req.usuario.pro ? req.usuario.id : null;

    const [r] = await conn.query(
      `INSERT INTO reservas (caravana_id, usuario_free_id, usuario_premium_id, status_pagamento, cupom_id, desconto, valor_total, expira_em)
       VALUES (?, ?, ?, 'pendente', ?, ?, ?, ?)`,
      [caravanaId, freeId, premId, cupom?.id || null, desconto, total, agoraMaisMinutosSP(MINUTOS_SEGURANDO_ASSENTO)]
    );

    if (Number(ocupados) + 1 >= Number(caravana.vagas_totais)) {
      await conn.query('UPDATE caravanas SET status = "lotada" WHERE id = ?', [caravanaId]);
    }
    await conn.commit();
    reservaCriada = { id: r.insertId, cupom_id: cupom?.id || null, caravana_id: caravanaId };

    const baseUrl = baseUrlDe(req);
    const sess = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: req.usuario.email || undefined,
      client_reference_id: String(req.usuario.id),
      metadata: { tipo: 'passagem', reserva_id: String(r.insertId), usuario_id: String(req.usuario.id), caravana_id: String(caravanaId) },
      expires_at: Math.floor(Date.now() / 1000) + MINUTOS_PARA_PAGAR * 60 + 30,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'brl',
          unit_amount: Math.round(total * 100),
          product_data: {
            name: `Passagem + ingresso: ${caravana.evento_nome}`,
            description: `Saída de ${caravana.cidade_saida} em ${caravana.data_saida.slice(0, 16)}` +
              (desconto ? ` · cupom -R$ ${desconto.toFixed(2)}` : '')
          }
        }
      }],
      success_url: `${baseUrl}/app.html?pagamento=sucesso&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/app.html?pagamento=cancelado&reserva=${r.insertId}`
    });
    await pool.query('UPDATE reservas SET stripe_session_id = ? WHERE id = ?', [sess.id, r.insertId]);

    await registrarAuditoria(req.usuario.id, 'reserva_iniciada',
      `Reserva #${r.insertId} na caravana #${caravanaId} (${caravana.evento_nome}) aguardando pagamento de R$ ${total.toFixed(2)}`, ip);
    res.status(201).json({ id: r.insertId, valor_total: total, desconto, pagamento_url: sess.url });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (reservaCriada) await liberarReserva(reservaCriada).catch(() => {});
    console.error('[Reservas] Erro ao reservar:', err.message);
    const msg = err.type?.startsWith('Stripe') ? `Pagamento indisponível: ${err.message}` : 'Erro ao reservar a passagem.';
    res.status(err.type?.startsWith('Stripe') ? 502 : 500).json({ error: msg });
  } finally {
    conn.release();
  }
});

app.get('/api/reservas/pagamento/confirmar', autenticado, async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id obrigatório.' });
  try {
    const sess = await stripe.checkout.sessions.retrieve(String(session_id));
    if (String(sess.metadata?.usuario_id) !== String(req.usuario.id)) {
      await registrarAuditoria(req.usuario.id, 'tentativa_negada_403', `Tentou confirmar pagamento ${session_id} de outro usuário`, getClientIp(req));
      return res.status(403).json({ error: 'Este pagamento não pertence a você.' });
    }
    const resultado = await confirmarReservaPaga(sess, getClientIp(req));
    if (!resultado.ok) return res.status(409).json({ error: resultado.motivo });
    res.json({ message: 'Pagamento aprovado! Passagem confirmada.', reserva_id: resultado.reserva.id });
  } catch (err) {
    console.error('[Reservas] Erro ao confirmar pagamento:', err.message);
    res.status(502).json({ error: 'Não foi possível confirmar o pagamento com o Stripe.' });
  }
});

app.get('/api/reservas/:id/pagamento', autenticado, async (req, res) => {
  const [[r]] = await pool.query('SELECT *, COALESCE(usuario_premium_id, usuario_free_id) AS dono_id FROM reservas WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Reserva não encontrada.' });
  if (r.dono_id !== req.usuario.id) {
    await registrarAuditoria(req.usuario.id, 'tentativa_negada_403', `Tentou abrir pagamento da reserva #${r.id} de outro usuário`, getClientIp(req));
    return res.status(403).json({ error: 'Esta reserva pertence a outro passageiro.' });
  }
  if (r.status_pagamento !== 'pendente' || !r.stripe_session_id) return res.status(409).json({ error: `Reserva está ${r.status_pagamento}.` });
  const sess = await stripe.checkout.sessions.retrieve(r.stripe_session_id);
  if (sess.status !== 'open' || !sess.url) return res.status(409).json({ error: 'O prazo de pagamento acabou. Faça uma nova reserva.' });
  res.json({ pagamento_url: sess.url });
});

app.delete('/api/reservas/:id', autenticado, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const [[reserva]] = await pool.query(
      `SELECT r.*, COALESCE(r.usuario_premium_id, r.usuario_free_id) AS dono_id, c.data_saida
         FROM reservas r JOIN caravanas c ON c.id = r.caravana_id WHERE r.id = ?`,
      [req.params.id]);
    if (!reserva) return res.status(404).json({ error: 'Reserva não encontrada.' });

    if (reserva.dono_id !== req.usuario.id && req.usuario.papel !== 'admin') {
      await registrarAuditoria(req.usuario.id, 'tentativa_negada_403',
        `Tentou cancelar a reserva #${req.params.id} de outro usuário (#${reserva.dono_id})`, ip);
      return res.status(403).json({ error: 'Esta reserva pertence a outro passageiro.' });
    }
    if (!['pendente', 'pago'].includes(reserva.status_pagamento)) {
      return res.status(409).json({ error: `Reserva já está ${reserva.status_pagamento}.` });
    }
    if (reserva.data_saida <= agoraSP()) return res.status(409).json({ error: 'A caravana já saiu.' });

    if (reserva.status_pagamento === 'pendente') {
      if (reserva.stripe_session_id) await stripe.checkout.sessions.expire(reserva.stripe_session_id).catch(() => {});
    } else {
      try {
        await estornarPagamento(reserva, 'cancelado pelo passageiro', ip);
      } catch (e) {
        console.error('[Stripe] Estorno falhou:', e.message);
        return res.status(502).json({ error: 'Não foi possível estornar o pagamento agora.' });
      }
    }
    await liberarReserva(reserva);

    await registrarAuditoria(req.usuario.id, 'reserva_cancelada',
      `Reserva #${reserva.id} (caravana #${reserva.caravana_id}, estava ${reserva.status_pagamento}) cancelada`, ip);
    res.json({ message: reserva.status_pagamento === 'pago' ? 'Reserva cancelada e valor estornado no cartão.' : 'Reserva cancelada.' });
  } catch (err) {
    console.error('[Reservas] Erro ao cancelar:', err);
    res.status(500).json({ error: 'Erro ao cancelar reserva.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CUPONS & BRINDES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/cupons', autenticado, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, codigo, desconto_percentual, descricao, caravana_id, validade, usado FROM cupons WHERE usuario_premium_id = ? ORDER BY usado, validade',
    [req.usuario.id]);
  res.json({ pro: req.usuario.pro, cupons: rows });
});

app.get('/api/brindes', autenticado, async (req, res) => {
  const [rows] = await pool.query(`
    SELECT b.*, c.cidade_saida, e.nome AS evento_nome,
           ct.nome AS ganhador_nome
      FROM brindes_premios_sorteios b
      LEFT JOIN caravanas c ON c.id = b.caravana_id
      LEFT JOIN eventos e   ON e.id = c.evento_id
      LEFT JOIN contas ct   ON ct.id = COALESCE(b.ganhador_premium_id, b.ganhador_free_id)
     ORDER BY b.criado_em DESC LIMIT 50
  `);
  res.json(rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// ORGANIZADOR — gerencia apenas as próprias caravanas e vê seus passageiros
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/organizador/caravanas', somenteOrganizador, async (req, res) => {
  const [rows] = req.usuario.papel === 'admin'
    ? await pool.query(`${SELECT_CARAVANA} ORDER BY c.data_saida DESC`)
    : await pool.query(`${SELECT_CARAVANA} WHERE c.organizador_id = ? ORDER BY c.data_saida DESC`, [req.usuario.id]);
  res.json(rows.map(montarCaravana));
});

app.get('/api/organizador/caravanas/:id/passageiros', somenteOrganizador, async (req, res) => {
  const [[c]] = await pool.query('SELECT id, organizador_id FROM caravanas WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Caravana não encontrada.' });
  if (req.usuario.papel !== 'admin' && c.organizador_id !== req.usuario.id) {
    await registrarAuditoria(req.usuario.id, 'tentativa_negada_403',
      `Organizador tentou ver passageiros da caravana #${req.params.id} de outro organizador`, getClientIp(req));
    return res.status(403).json({ error: 'Você não é o organizador desta caravana.' });
  }
  const [rows] = await pool.query(
    `SELECT r.id, r.status_pagamento, r.valor_total, ct.nome, ct.time_torcida,
            (CASE WHEN r.usuario_premium_id IS NOT NULL THEN 'Pro' ELSE 'Free' END) AS plano
       FROM reservas r
       JOIN contas ct ON ct.id = COALESCE(r.usuario_premium_id, r.usuario_free_id)
      WHERE r.caravana_id = ? AND r.status_pagamento <> 'cancelado'
      ORDER BY r.criado_em`, [c.id]);
  res.json(rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — papéis, cupons, brindes/sorteios e auditoria
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/usuarios', somenteAdmin, async (req, res) => {
  try {
    const { data } = await axios.get(`${AUTH_SERVICE_URL}/users`);
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao listar usuários.' });
  }
});

app.put('/api/admin/usuarios/:id/papel', somenteAdmin, async (req, res) => {
  try {
    const { data } = await axios.put(`${AUTH_SERVICE_URL}/users/${encodeURIComponent(req.params.id)}/role`,
      { role: req.body.role || req.body.papel, admin_id: req.usuario.id },
      { headers: { 'x-forwarded-for': getClientIp(req) } });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao alterar papel.' });
  }
});

app.post('/api/admin/cupons', somenteAdmin, async (req, res) => {
  const usuarioId = Number(req.body.usuario_id);
  const pct = Number(req.body.desconto_percentual || req.body.desconto_pct);
  const dias = Number(req.body.dias_validade) || 60;
  const caravanaId = req.body.caravana_id ? Number(req.body.caravana_id) : null;
  if (!usuarioId || !(pct > 0 && pct <= 50)) return res.status(400).json({ error: 'Informe o usuário e desconto entre 1 e 50%.' });

  const [[up]] = await pool.query('SELECT conta_id, ativo FROM usuarios_premium WHERE conta_id = ?', [usuarioId]);
  if (!up || up.ativo != 1) return res.status(400).json({ error: 'Cupons são exclusivos para assinantes Premium ativos.' });

  const cupom = await gerarCupom(usuarioId, pct, String(req.body.descricao || 'Cupom do organizador').slice(0, 255), dias, caravanaId);
  await registrarAuditoria(req.usuario.id, 'cupom_gerado', `Cupom ${cupom.codigo} (${pct}%) para conta #${usuarioId}`, getClientIp(req));
  res.status(201).json(cupom);
});

app.post('/api/admin/brindes/sortear', somenteAdmin, async (req, res) => {
  const caravanaId = Number(req.body.caravana_id);
  const nome = String(req.body.nome || 'Camisa oficial').trim().slice(0, 150);
  const tipo = ['brinde', 'premio', 'sorteio'].includes(req.body.tipo) ? req.body.tipo : 'sorteio';
  if (!caravanaId) return res.status(400).json({ error: 'caravana_id obrigatório.' });

  const [candidatos] = await pool.query(`
    SELECT r.usuario_free_id, r.usuario_premium_id, ct.nome
      FROM reservas r
      JOIN contas ct ON ct.id = COALESCE(r.usuario_premium_id, r.usuario_free_id)
     WHERE r.caravana_id = ? AND r.status_pagamento = 'pago'
  `, [caravanaId]);
  if (!candidatos.length) return res.status(409).json({ error: 'Nenhum passageiro pago nesta caravana.' });

  const ganhador = candidatos[crypto.randomInt(candidatos.length)];
  const [ins] = await pool.query(
    `INSERT INTO brindes_premios_sorteios (tipo, nome, descricao, caravana_id, data_sorteio, ganhador_free_id, ganhador_premium_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tipo, nome, String(req.body.descricao || '').slice(0, 255) || null, caravanaId, agoraSP(),
     ganhador.usuario_free_id, ganhador.usuario_premium_id]
  );
  await registrarAuditoria(req.usuario.id, 'brinde_sorteado',
    `"${nome}" (${tipo}) para ${ganhador.nome} na caravana #${caravanaId}`, getClientIp(req));
  res.status(201).json({ id: ins.insertId, ganhador: ganhador.nome, nome, tipo });
});

app.get('/api/logs', somenteAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const response = await axios.get(`${LOG_SERVICE_URL}/logs?limit=${limit}`);
    res.json(response.data);
  } catch (err) {
    console.error('Erro ao consultar log-service:', err.message);
    res.status(500).json({ error: 'Erro ao consultar microsserviço de auditoria.' });
  }
});

app.delete('/api/logs/:id', somenteAdmin, async (req, res) => {
  try {
    const response = await axios.delete(`${LOG_SERVICE_URL}/logs/${encodeURIComponent(req.params.id)}`);
    await registrarAuditoria(req.usuario.id, 'deletar_log', `Admin apagou o registro de auditoria ID ${req.params.id}`, getClientIp(req));
    res.json(response.data);
  } catch (err) {
    console.error('Erro ao apagar log no log-service:', err.message);
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao apagar log de auditoria.' });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo muito grande. O máximo é 10 MB.' });
    return res.status(400).json({ error: `Erro no upload: ${err.message}` });
  }
  if (err && err.status === 400) return res.status(400).json({ error: err.message });
  console.error('[Erro não tratado]', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Caravana's Hub rodando na porta ${PORT}`));
