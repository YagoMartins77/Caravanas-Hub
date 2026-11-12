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

// Express 4 não captura erro de handler async: sem isto, uma exceção numa rota
// vira "unhandled rejection" e a requisição fica pendurada. Aqui todo handler
// das rotas passa o erro adiante para o tratador global (fim do arquivo).
for (const metodo of ['get', 'post', 'put', 'delete']) {
  const original = app[metodo].bind(app);
  app[metodo] = (rota, ...handlers) => {
    if (handlers.length === 0) return original(rota); // app.get('config')
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

// ─── Regras do negócio (Caravanas Hub) ───────────────────────────────────────
// Só atendemos saídas da Alta Paulista.
const CIDADES_ALTA_PAULISTA = [
  'Adamantina', 'Bastos', 'Dracena', 'Flórida Paulista', 'Garça', 'Herculândia',
  'Inúbia Paulista', 'Junqueirópolis', 'Lucélia', 'Marília', 'Osvaldo Cruz',
  'Pacaembu', 'Parapuã', 'Pompeia', 'Quintana', 'Rinópolis', 'Tupã', 'Vera Cruz'
];
const MODALIDADES = ['futebol', 'f1', 'mma'];
// Quantos dias antes do plano Free o assinante Pro enxerga e compra a caravana.
const ANTECEDENCIA_PRO_DIAS = Number(process.env.ANTECEDENCIA_PRO_DIAS) || 3;
// Cupom de boas-vindas gerado automaticamente quando o usuário vira Pro.
const CUPOM_BOAS_VINDAS_PCT = 10;

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

const AVATAR_BUCKET  = 'avatars';
const VEICULO_BUCKET = 'veiculos';
const BUCKETS = [AVATAR_BUCKET, VEICULO_BUCKET];

// Garante UM bucket (cria + política de leitura pública se ainda não existir).
async function garantirBucket(bucket) {
  const exists = await minioClient.bucketExists(bucket);
  if (exists) return;
  try {
    await minioClient.makeBucket(bucket, 'us-east-1');
  } catch (e) {
    // Outra requisição pode ter criado o bucket no mesmo instante
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

// No docker-compose, "depends_on" só espera o container do MinIO iniciar, não ficar pronto.
// Por isso tentamos várias vezes na subida.
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

// Extensão segura para o nome do objeto (derivada do tipo real do arquivo, não do nome enviado)
const EXT_POR_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp'
};
function mimeBase(file) {
  return String(file?.mimetype || '').split(';')[0].trim().toLowerCase();
}

// ─── Multer ───────────────────────────────────────────────────────────────────
function erroUpload(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

// SVG fica de fora: pode carregar script.
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
// dateStrings: as datas voltam como 'YYYY-MM-DD HH:MM:SS' no horário de Brasília,
// do jeito que foram cadastradas, sem conversão de fuso pelo driver.
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

// "Agora" no fuso de São Paulo, no mesmo formato das colunas DATETIME.
function agoraSP() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace('T', ' ');
}
function hojeSP() {
  return agoraSP().slice(0, 10);
}
// Converte "2026-12-06T07:00" (input datetime-local) para "2026-12-06 07:00:00"
function normalizarDataHora(v) {
  if (!v) return null;
  const s = String(v).trim().replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return `${s}:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  return null;
}

// ─── Migração versionada: db/001_dominio.sql ─────────────────────────────────
// Roda o mesmo script que fica no repositório, statement por statement.
function localizarMigracao() {
  const candidatos = [
    path.join(__dirname, 'db', '001_dominio.sql'),       // dentro do container
    path.join(__dirname, '..', 'db', '001_dominio.sql')  // rodando local, na pasta do serviço
  ];
  return candidatos.find(p => fs.existsSync(p));
}

async function migrarBanco() {
  const arquivo = localizarMigracao();
  if (!arquivo) {
    console.error('[DB] db/001_dominio.sql não encontrado. Migração não executada.');
    return;
  }

  // Descobre o tipo real de usuarios.id (INT ou INT UNSIGNED) para as FKs baterem.
  let tipoUsuarioId = 'INT';
  try {
    const [cols] = await pool.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'id'`
    );
    if (cols.length) tipoUsuarioId = cols[0].COLUMN_TYPE.toUpperCase();
  } catch {}

  const sql = fs.readFileSync(arquivo, 'utf8')
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\bINT( NOT)? NULL \/\*FK_USUARIO\*\//g, (_, not) => `${tipoUsuarioId}${not || ''} NULL`);

  const statements = sql.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
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

// Dispara eventos para o microsserviço de auditoria (Redis Streams)
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

// ─── Pro: ativação + cupom de boas-vindas ────────────────────────────────────
async function gerarCupom(usuarioId, descontoPct, descricao, diasValidade = 90) {
  const codigo = `PRO-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const validade = new Date(Date.now() + diasValidade * 86400000).toISOString().slice(0, 10);
  await pool.query(
    'INSERT INTO cupons (usuario_id, codigo, desconto_pct, descricao, validade) VALUES (?, ?, ?, ?, ?)',
    [usuarioId, codigo, descontoPct, descricao, validade]
  );
  return { codigo, desconto_pct: descontoPct, validade };
}

async function ativarPro(usuarioId, customerId, origem, ip = '') {
  const [antes] = await pool.query('SELECT premium FROM usuarios WHERE id = ?', [usuarioId]);
  const jaEraPro = antes.length && antes[0].premium == 1;
  await pool.query('UPDATE usuarios SET premium = 1, stripe_customer_id = COALESCE(?, stripe_customer_id) WHERE id = ?',
    [customerId || null, usuarioId]);
  if (jaEraPro) return;

  await registrarAuditoria(usuarioId, 'upgrade_pro', `Assinatura Pro ativada (${origem})`, ip);
  try {
    const cupom = await gerarCupom(usuarioId, CUPOM_BOAS_VINDAS_PCT, 'Boas-vindas ao Caravanas Hub Pro');
    await registrarAuditoria(usuarioId, 'cupom_gerado', `Cupom ${cupom.codigo} (${CUPOM_BOAS_VINDAS_PCT}%) de boas-vindas`, ip);
  } catch (e) {
    console.error('[Pro] Erro ao gerar cupom de boas-vindas:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — Webhook (precisa do corpo bruto, por isso vem ANTES do express.json)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      if (STRIPE_WEBHOOK_SECRET) {
        const sig = req.headers['stripe-signature'];
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      } else {
        event = JSON.parse(req.body.toString());
      }
    } catch (err) {
      console.error('[Stripe Webhook] Assinatura inválida:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const sess = event.data.object;
      const usuarioId = sess.client_reference_id || sess.metadata?.usuario_id;
      if (usuarioId) {
        try {
          await ativarPro(usuarioId, sess.customer, 'webhook Stripe');
        } catch (dbErr) {
          console.error('[Stripe] Erro ao atualizar DB:', dbErr.message);
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const customerId = event.data.object.customer;
      try {
        await pool.query('UPDATE usuarios SET premium = 0 WHERE stripe_customer_id = ?', [customerId]);
        console.log(`[Stripe] Assinatura cancelada para customer ${customerId}.`);
      } catch {}
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
// Assim, se o admin muda o papel de alguém, vale na próxima requisição.
async function carregarUsuario(req, res, next) {
  if (!req.session.usuario) return res.status(401).json({ error: 'Faça login.' });
  try {
    const [rows] = await pool.query('SELECT id, nome, email, role, premium FROM usuarios WHERE id = ?', [req.session.usuario.id]);
    if (!rows.length) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
    }
    req.usuario = {
      ...rows[0],
      // Admin enxerga tudo, inclusive o que é do Pro
      pro: rows[0].role === 'admin' || rows[0].premium == 1
    };
    req.session.usuario.role = rows[0].role;
    req.session.usuario.premium = req.usuario.pro ? 1 : 0;
    next();
  } catch (err) {
    console.error('[RBAC] Erro ao carregar usuário:', err.message);
    res.status(500).json({ error: 'Erro ao validar sessão.' });
  }
}

// Exige um dos papéis informados. Responde 403 (e registra no log) mesmo se a
// chamada vier direto por curl/Postman, sem passar pela tela.
function exigirPapel(...papeis) {
  return [carregarUsuario, async (req, res, next) => {
    if (papeis.includes(req.usuario.role)) return next();
    await registrarAuditoria(
      req.usuario.id,
      'tentativa_negada_403',
      `Papel "${req.usuario.role}" tentou [${req.method} ${req.originalUrl}] (exige: ${papeis.join(' ou ')})`,
      getClientIp(req)
    );
    return res.status(403).json({ error: `Acesso negado: ação permitida apenas para ${papeis.join(' ou ')}.` });
  }];
}

const autenticado = carregarUsuario;
const somenteAdmin = exigirPapel('admin');

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
    const [rows] = await pool.query('SELECT id, nome, email, role, premium, avatar_url FROM usuarios WHERE id = ?', [req.session.usuario.id]);
    if (!rows.length) return res.status(401).json({ error: 'Deslogado' });
    const u = rows[0];
    req.session.usuario = { ...req.session.usuario, ...u, premium: (u.role === 'admin' || u.premium == 1) ? 1 : 0 };
  } catch {}
  res.json({ ...req.session.usuario, antecedencia_pro_dias: ANTECEDENCIA_PRO_DIAS });
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const response = await axios.post(`${AUTH_SERVICE_URL}/forgot-password`, {
      email: req.body.email,
      baseUrl
    }, {
      headers: { 'x-forwarded-for': getClientIp(req) }
    });
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
              name: 'Caravanas Hub Pro',
              description: `Cupons de desconto, sorteio de brindes e acesso às caravanas ${ANTECEDENCIA_PRO_DIAS} dias antes`
            },
            unit_amount: 1990, // R$ 19,90 por mês
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
      metadata: { usuario_id: String(req.usuario.id) }
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('[Stripe] Erro ao criar checkout:', err.message);
    res.status(500).json({ error: `Erro ao iniciar o checkout: ${err.message}` });
  }
});

// Retorno imediato do checkout (não depende do webhook chegar)
app.get('/api/stripe/verify-session', autenticado, async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id obrigatório' });

  try {
    const sess = await stripe.checkout.sessions.retrieve(session_id);
    const dono = sess.client_reference_id || sess.metadata?.usuario_id;
    // Isolamento: só confirma a sessão de checkout que pertence ao usuário logado
    if (String(dono) !== String(req.usuario.id)) {
      return res.status(403).json({ error: 'Esta sessão de pagamento não pertence a você.' });
    }
    if (sess.status === 'complete' || sess.payment_status === 'paid') {
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
    if (usuario.role === 'admin') {
      return res.json({ success: true, premium: true, message: 'Administrador já tem todos os benefícios Pro.' });
    }

    const [rows] = await pool.query('SELECT stripe_customer_id FROM usuarios WHERE id = ?', [usuario.id]);
    let customerId = rows[0]?.stripe_customer_id;

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
    const [rows] = await pool.query('SELECT stripe_customer_id FROM usuarios WHERE id = ?', [usuario.id]);
    const customerId = rows[0]?.stripe_customer_id;

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

    await pool.query('UPDATE usuarios SET premium = 0 WHERE id = ?', [usuario.id]);
    await registrarAuditoria(usuario.id, 'cancelar_pro', `Assinatura Pro cancelada (${canceladas} removidas no Stripe)`, getClientIp(req));
    res.json({ success: true, message: 'Assinatura Pro cancelada.' });
  } catch (err) {
    console.error('[Stripe] Erro ao cancelar:', err.message);
    res.status(500).json({ error: 'Erro ao cancelar assinatura: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MINIO — Avatar do usuário e foto do veículo
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
    await pool.query('UPDATE usuarios SET avatar_url = ? WHERE id = ?', [url, req.usuario.id]);
    await registrarAuditoria(req.usuario.id, 'upload_avatar', `Avatar salvo no MinIO: ${objectName}`, getClientIp(req));
    res.json({ url });
  } catch (err) {
    console.error('[MinIO] Erro upload avatar:', err);
    res.status(500).json({ error: 'Erro ao fazer upload do avatar.' });
  }
});

// Proxy de mídia (resolve o DNS interno 'minio' e mantém tudo na mesma origem)
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
// PREÇO DA PASSAGEM
// O ingresso é repassado a preço de custo (sem lucro). O lucro está só na viagem:
//   custo_viagem = (2 × km / consumo) × R$/litro + motorista + pedágio
//   passagem     = custo_viagem / lugares × (1 + margem) + ingresso
// ─────────────────────────────────────────────────────────────────────────────
function arred(v) { return Math.round(Number(v) * 100) / 100; }

function calcularPreco(c) {
  const km = Number(c.distancia_km);
  const consumo = Number(c.consumo_km_l) || 1;
  const lugares = Number(c.capacidade) || 1;
  const litros = (2 * km) / consumo;
  const combustivel = litros * Number(c.preco_litro);
  const custoViagem = combustivel + Number(c.custo_motorista) + Number(c.custo_pedagio);
  const custoPorLugar = custoViagem / lugares;
  const valorViagem = custoPorLugar * (1 + Number(c.margem_pct) / 100);
  const ingresso = Number(c.valor_ingresso);
  return {
    litros: arred(litros),
    combustivel: arred(combustivel),
    custo_viagem: arred(custoViagem),
    custo_por_lugar: arred(custoPorLugar),
    lucro_por_lugar: arred(valorViagem - custoPorLugar),
    valor_viagem: arred(valorViagem),
    valor_ingresso: arred(ingresso),
    valor_passagem: arred(valorViagem + ingresso)
  };
}

// Quando a caravana fica visível para o Pro (antes do Free)
function aberturaPro(aberturaGeral) {
  const d = new Date(aberturaGeral.replace(' ', 'T') + 'Z');
  d.setUTCDate(d.getUTCDate() - ANTECEDENCIA_PRO_DIAS);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const SELECT_CARAVANA = `
  SELECT c.*, e.modalidade, e.titulo, e.competicao, e.local_nome, e.cidade_destino, e.data_evento,
         e.valor_ingresso, e.escudo_mandante, e.escudo_visitante,
         v.tipo AS veiculo_tipo, v.modelo AS veiculo_modelo, v.capacidade, v.consumo_km_l, v.foto_url AS veiculo_foto,
         m.nome AS motorista_nome,
         (SELECT COUNT(*) FROM reservas r WHERE r.caravana_id = c.id AND r.status <> 'cancelada') AS ocupados
    FROM caravanas c
    JOIN eventos  e ON e.id = c.evento_id
    JOIN veiculos v ON v.id = c.veiculo_id
    LEFT JOIN usuarios m ON m.id = c.motorista_id`;

function montarCaravana(row, usuario) {
  const preco = calcularPreco(row);
  const abertura_pro_em = aberturaPro(row.abertura_vendas_em);
  const agora = agoraSP();
  const out = {
    ...row,
    ocupados: Number(row.ocupados),
    vagas: Math.max(0, Number(row.capacidade) - Number(row.ocupados)),
    abertura_pro_em,
    exclusiva_pro_agora: abertura_pro_em <= agora && row.abertura_vendas_em > agora,
    preco
  };
  // Custos internos (combustível, margem, lucro) só para a equipe
  if (usuario.role !== 'admin') {
    delete out.custo_motorista; delete out.preco_litro; delete out.margem_pct;
    delete out.custo_pedagio; delete out.criado_por;
    out.preco = { valor_viagem: preco.valor_viagem, valor_ingresso: preco.valor_ingresso, valor_passagem: preco.valor_passagem };
  }
  return out;
}

// Regra de visibilidade: admin vê tudo; Pro vê X dias antes; Free só após a abertura geral.
function visivelPara(row, usuario) {
  if (usuario.role === 'admin') return true;
  if (row.status === 'cancelada') return false;
  const agora = agoraSP();
  const abertura = usuario.pro ? aberturaPro(row.abertura_vendas_em) : row.abertura_vendas_em;
  return abertura <= agora;
}

// ─────────────────────────────────────────────────────────────────────────────
// CARAVANAS — recurso principal (CRUD)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/caravanas', autenticado, async (req, res) => {
  try {
    const params = [];
    let where = ' WHERE 1=1';
    if (req.query.modalidade && MODALIDADES.includes(req.query.modalidade)) {
      where += ' AND e.modalidade = ?';
      params.push(req.query.modalidade);
    }
    if (req.query.cidade) {
      where += ' AND c.cidade_saida = ?';
      params.push(req.query.cidade);
    }
    // Viagens que já saíram ficam fora da vitrine (admin continua vendo tudo)
    if (req.usuario.role !== 'admin') {
      where += ' AND c.data_saida > ?';
      params.push(agoraSP());
    }
    const [rows] = await pool.query(`${SELECT_CARAVANA}${where} ORDER BY c.data_saida`, params);

    const visiveis = rows.filter(r => visivelPara(r, req.usuario));
    // Quantas caravanas o Free ainda não vê porque estão no período exclusivo do Pro
    const exclusivasPro = req.usuario.pro ? 0 : rows.filter(r =>
      r.status !== 'cancelada' && !visivelPara(r, req.usuario) && aberturaPro(r.abertura_vendas_em) <= agoraSP()
    ).length;

    res.json({
      caravanas: visiveis.map(r => montarCaravana(r, req.usuario)),
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
    // Caravana ainda não liberada para o plano do usuário = "não existe" para ele
    if (!rows.length || !visivelPara(rows[0], req.usuario)) {
      return res.status(404).json({ error: 'Caravana não encontrada.' });
    }
    res.json(montarCaravana(rows[0], req.usuario));
  } catch (err) {
    console.error('[Caravanas] Erro ao detalhar:', err);
    res.status(500).json({ error: 'Erro ao buscar caravana.' });
  }
});

// Valida e normaliza o corpo de criação/edição de caravana
async function validarCaravana(body, atual = {}) {
  const d = { ...atual, ...body };
  const erros = [];
  const out = {
    evento_id: Number(d.evento_id),
    veiculo_id: Number(d.veiculo_id),
    motorista_id: d.motorista_id ? Number(d.motorista_id) : null,
    cidade_saida: String(d.cidade_saida || '').trim(),
    ponto_encontro: String(d.ponto_encontro || '').trim(),
    data_saida: normalizarDataHora(d.data_saida),
    distancia_km: Number(d.distancia_km),
    preco_litro: Number(d.preco_litro),
    custo_motorista: Number(d.custo_motorista),
    custo_pedagio: Number(d.custo_pedagio || 0),
    margem_pct: d.margem_pct === undefined || d.margem_pct === '' ? 20 : Number(d.margem_pct),
    abertura_vendas_em: normalizarDataHora(d.abertura_vendas_em),
    status: d.status || 'aberta'
  };

  if (!CIDADES_ALTA_PAULISTA.includes(out.cidade_saida)) erros.push('Cidade de saída precisa ser da Alta Paulista.');
  if (!out.ponto_encontro) erros.push('Informe o ponto de encontro.');
  if (!out.data_saida) erros.push('Data de saída inválida.');
  if (!out.abertura_vendas_em) erros.push('Data de abertura das vendas inválida.');
  if (!(out.distancia_km > 0)) erros.push('Distância deve ser maior que zero.');
  if (!(out.preco_litro > 0)) erros.push('Preço do litro deve ser maior que zero.');
  if (!(out.custo_motorista >= 0)) erros.push('Custo do motorista inválido.');
  if (!(out.custo_pedagio >= 0)) erros.push('Custo de pedágio inválido.');
  if (!(out.margem_pct >= 0 && out.margem_pct <= 100)) erros.push('Margem deve ficar entre 0 e 100%.');
  if (!['aberta', 'lotada', 'cancelada', 'concluida'].includes(out.status)) erros.push('Status inválido.');

  const [[evento]] = await pool.query('SELECT id FROM eventos WHERE id = ?', [out.evento_id]);
  if (!evento) erros.push('Evento não encontrado.');
  const [[veiculo]] = await pool.query('SELECT id FROM veiculos WHERE id = ? AND ativo = 1', [out.veiculo_id]);
  if (!veiculo) erros.push('Veículo não encontrado ou inativo.');
  if (out.motorista_id) {
    const [[mot]] = await pool.query('SELECT id FROM usuarios WHERE id = ? AND role = "motorista"', [out.motorista_id]);
    if (!mot) erros.push('O usuário escolhido não tem o papel de motorista.');
  }
  return { dados: out, erros };
}

app.post('/api/caravanas', somenteAdmin, async (req, res) => {
  try {
    const { dados, erros } = await validarCaravana(req.body);
    if (erros.length) return res.status(400).json({ error: erros.join(' ') });

    const [result] = await pool.query(
      `INSERT INTO caravanas (evento_id, veiculo_id, motorista_id, criado_por, cidade_saida, ponto_encontro, data_saida,
         distancia_km, preco_litro, custo_motorista, custo_pedagio, margem_pct, abertura_vendas_em, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [dados.evento_id, dados.veiculo_id, dados.motorista_id, req.usuario.id, dados.cidade_saida, dados.ponto_encontro,
       dados.data_saida, dados.distancia_km, dados.preco_litro, dados.custo_motorista, dados.custo_pedagio,
       dados.margem_pct, dados.abertura_vendas_em, dados.status]
    );
    await registrarAuditoria(req.usuario.id, 'caravana_criada',
      `Caravana #${result.insertId} saindo de ${dados.cidade_saida} (evento #${dados.evento_id})`, getClientIp(req));
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error('[Caravanas] Erro ao criar:', err);
    res.status(500).json({ error: 'Erro ao criar caravana.' });
  }
});

app.put('/api/caravanas/:id', somenteAdmin, async (req, res) => {
  try {
    const [[atual]] = await pool.query('SELECT * FROM caravanas WHERE id = ?', [req.params.id]);
    if (!atual) return res.status(404).json({ error: 'Caravana não encontrada.' });

    const { dados, erros } = await validarCaravana(req.body, atual);
    if (erros.length) return res.status(400).json({ error: erros.join(' ') });

    await pool.query(
      `UPDATE caravanas SET evento_id=?, veiculo_id=?, motorista_id=?, cidade_saida=?, ponto_encontro=?, data_saida=?,
         distancia_km=?, preco_litro=?, custo_motorista=?, custo_pedagio=?, margem_pct=?, abertura_vendas_em=?, status=?
       WHERE id = ?`,
      [dados.evento_id, dados.veiculo_id, dados.motorista_id, dados.cidade_saida, dados.ponto_encontro, dados.data_saida,
       dados.distancia_km, dados.preco_litro, dados.custo_motorista, dados.custo_pedagio, dados.margem_pct,
       dados.abertura_vendas_em, dados.status, req.params.id]
    );
    const acao = dados.status === 'cancelada' && atual.status !== 'cancelada' ? 'caravana_cancelada' : 'caravana_editada';
    await registrarAuditoria(req.usuario.id, acao, `Caravana #${req.params.id} (${dados.cidade_saida}, status ${dados.status})`, getClientIp(req));
    res.json({ message: 'Caravana atualizada.' });
  } catch (err) {
    console.error('[Caravanas] Erro ao editar:', err);
    res.status(500).json({ error: 'Erro ao editar caravana.' });
  }
});

// Remover: se já tem passageiro, vira "cancelada" (e as reservas também); senão apaga.
app.delete('/api/caravanas/:id', somenteAdmin, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const [[atual]] = await pool.query('SELECT id, cidade_saida FROM caravanas WHERE id = ?', [req.params.id]);
    if (!atual) return res.status(404).json({ error: 'Caravana não encontrada.' });

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM reservas WHERE caravana_id = ? AND status <> "cancelada"', [req.params.id]);

    if (Number(total) > 0) {
      await pool.query('UPDATE caravanas SET status = "cancelada" WHERE id = ?', [req.params.id]);
      await pool.query('UPDATE reservas SET status = "cancelada", assento = NULL WHERE caravana_id = ? AND status <> "cancelada"', [req.params.id]);
      await pool.query(
        'UPDATE cupons SET usado = 0 WHERE id IN (SELECT cupom_id FROM reservas WHERE caravana_id = ? AND cupom_id IS NOT NULL)', [req.params.id]);
      await registrarAuditoria(req.usuario.id, 'caravana_cancelada',
        `Caravana #${req.params.id} (${atual.cidade_saida}) cancelada com ${total} passageiro(s) reembolsado(s)`, ip);
      return res.json({ message: `Caravana cancelada. ${total} reserva(s) cancelada(s) e cupons devolvidos.` });
    }

    await pool.query('DELETE FROM caravanas WHERE id = ?', [req.params.id]);
    await registrarAuditoria(req.usuario.id, 'caravana_removida', `Caravana #${req.params.id} (${atual.cidade_saida}) removida`, ip);
    res.json({ message: 'Caravana removida.' });
  } catch (err) {
    console.error('[Caravanas] Erro ao remover:', err);
    res.status(500).json({ error: 'Erro ao remover caravana.' });
  }
});

// Dados auxiliares para os formulários
app.get('/api/meta', autenticado, (req, res) => {
  res.json({ cidades: CIDADES_ALTA_PAULISTA, modalidades: MODALIDADES, antecedencia_pro_dias: ANTECEDENCIA_PRO_DIAS });
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENTOS (jogo, corrida, luta)
// ─────────────────────────────────────────────────────────────────────────────
function validarEvento(d) {
  const erros = [];
  const out = {
    modalidade: d.modalidade,
    titulo: String(d.titulo || '').trim(),
    competicao: String(d.competicao || '').trim() || null,
    local_nome: String(d.local_nome || '').trim(),
    cidade_destino: String(d.cidade_destino || '').trim(),
    data_evento: normalizarDataHora(d.data_evento),
    valor_ingresso: Number(d.valor_ingresso || 0)
  };
  if (!MODALIDADES.includes(out.modalidade)) erros.push('Modalidade deve ser futebol, f1 ou mma.');
  if (!out.titulo) erros.push('Informe o título.');
  if (!out.local_nome) erros.push('Informe o local.');
  if (!out.cidade_destino) erros.push('Informe a cidade de destino.');
  if (!out.data_evento) erros.push('Data do evento inválida.');
  if (!(out.valor_ingresso >= 0)) erros.push('Valor do ingresso inválido.');
  return { dados: out, erros };
}

app.get('/api/eventos', somenteAdmin, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM eventos ORDER BY data_evento');
  res.json(rows);
});

app.post('/api/eventos', somenteAdmin, async (req, res) => {
  const { dados, erros } = validarEvento(req.body);
  if (erros.length) return res.status(400).json({ error: erros.join(' ') });
  const [r] = await pool.query(
    'INSERT INTO eventos (modalidade, titulo, competicao, local_nome, cidade_destino, data_evento, valor_ingresso) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [dados.modalidade, dados.titulo, dados.competicao, dados.local_nome, dados.cidade_destino, dados.data_evento, dados.valor_ingresso]
  );
  await registrarAuditoria(req.usuario.id, 'evento_criado', `Evento #${r.insertId}: ${dados.titulo}`, getClientIp(req));
  res.status(201).json({ id: r.insertId });
});

app.put('/api/eventos/:id', somenteAdmin, async (req, res) => {
  const [[atual]] = await pool.query('SELECT * FROM eventos WHERE id = ?', [req.params.id]);
  if (!atual) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { dados, erros } = validarEvento({ ...atual, ...req.body });
  if (erros.length) return res.status(400).json({ error: erros.join(' ') });
  await pool.query(
    'UPDATE eventos SET modalidade=?, titulo=?, competicao=?, local_nome=?, cidade_destino=?, data_evento=?, valor_ingresso=? WHERE id = ?',
    [dados.modalidade, dados.titulo, dados.competicao, dados.local_nome, dados.cidade_destino, dados.data_evento, dados.valor_ingresso, req.params.id]
  );
  await registrarAuditoria(req.usuario.id, 'evento_editado', `Evento #${req.params.id}: ${dados.titulo}`, getClientIp(req));
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

app.get('/api/futebol/campeonatos', somenteAdmin, async (req, res) => {
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

app.get('/api/futebol/partidas', somenteAdmin, async (req, res) => {
  try {
    const campeonato = Number(req.query.campeonato) || 10; // 10 = Brasileirão
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

app.post('/api/futebol/importar', somenteAdmin, async (req, res) => {
  const partidaId = Number(req.body.partida_id);
  if (!partidaId) return res.status(400).json({ error: 'partida_id obrigatório.' });
  try {
    const { data } = await futebolApi.get(`/partidas/${partidaId}`);
    const p = mapearPartida(data);
    const dataEvento = p.data_iso
      ? p.data_iso.slice(0, 19).replace('T', ' ')
      : (normalizarDataHora(req.body.data_evento) || `${hojeSP()} 16:00:00`);

    const [r] = await pool.query(
      `INSERT INTO eventos (modalidade, titulo, competicao, local_nome, cidade_destino, data_evento, valor_ingresso,
                            api_partida_id, escudo_mandante, escudo_visitante)
       VALUES ('futebol', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`${p.mandante} x ${p.visitante}`, p.campeonato, p.estadio || 'Estádio a definir',
       String(req.body.cidade_destino || 'A definir').trim(), dataEvento, Number(req.body.valor_ingresso) || 0,
       partidaId, p.escudo_mandante, p.escudo_visitante]
    );
    await registrarAuditoria(req.usuario.id, 'evento_importado_api',
      `Partida ${partidaId} (${p.mandante} x ${p.visitante}) importada da API Futebol como evento #${r.insertId}`, getClientIp(req));
    res.status(201).json({ id: r.insertId, titulo: `${p.mandante} x ${p.visitante}` });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Essa partida já foi importada.' });
    console.error('[API Futebol] importar:', err.response?.status, err.message);
    res.status(502).json({ error: 'Não foi possível importar a partida da API Futebol.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VEÍCULOS (frota própria) + foto no MinIO
// ─────────────────────────────────────────────────────────────────────────────
function validarVeiculo(d) {
  const erros = [];
  const out = {
    tipo: d.tipo,
    modelo: String(d.modelo || '').trim(),
    placa: String(d.placa || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''),
    capacidade: Number(d.capacidade),
    consumo_km_l: Number(d.consumo_km_l),
    ativo: d.ativo === undefined ? 1 : (Number(d.ativo) ? 1 : 0)
  };
  if (!['van', 'onibus'].includes(out.tipo)) erros.push('Tipo deve ser van ou onibus.');
  if (!out.modelo) erros.push('Informe o modelo.');
  if (!/^[A-Z0-9]{7}$/.test(out.placa)) erros.push('Placa inválida.');
  if (!(Number.isInteger(out.capacidade) && out.capacidade > 0 && out.capacidade <= 60)) erros.push('Capacidade entre 1 e 60.');
  if (!(out.consumo_km_l > 0)) erros.push('Consumo (km/l) deve ser maior que zero.');
  return { dados: out, erros };
}

app.get('/api/veiculos', somenteAdmin, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM veiculos ORDER BY ativo DESC, tipo, modelo');
  res.json(rows);
});

app.post('/api/veiculos', somenteAdmin, async (req, res) => {
  const { dados, erros } = validarVeiculo(req.body);
  if (erros.length) return res.status(400).json({ error: erros.join(' ') });
  try {
    const [r] = await pool.query(
      'INSERT INTO veiculos (tipo, modelo, placa, capacidade, consumo_km_l, ativo) VALUES (?, ?, ?, ?, ?, ?)',
      [dados.tipo, dados.modelo, dados.placa, dados.capacidade, dados.consumo_km_l, dados.ativo]
    );
    await registrarAuditoria(req.usuario.id, 'veiculo_cadastrado', `${dados.tipo} ${dados.placa} (${dados.capacidade} lugares)`, getClientIp(req));
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Placa já cadastrada.' });
    throw err;
  }
});

app.put('/api/veiculos/:id', somenteAdmin, async (req, res) => {
  const [[atual]] = await pool.query('SELECT * FROM veiculos WHERE id = ?', [req.params.id]);
  if (!atual) return res.status(404).json({ error: 'Veículo não encontrado.' });
  const { dados, erros } = validarVeiculo({ ...atual, ...req.body });
  if (erros.length) return res.status(400).json({ error: erros.join(' ') });
  try {
    await pool.query(
      'UPDATE veiculos SET tipo=?, modelo=?, placa=?, capacidade=?, consumo_km_l=?, ativo=? WHERE id = ?',
      [dados.tipo, dados.modelo, dados.placa, dados.capacidade, dados.consumo_km_l, dados.ativo, req.params.id]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Placa já cadastrada.' });
    throw err;
  }
  await registrarAuditoria(req.usuario.id, 'veiculo_editado', `Veículo #${req.params.id} (${dados.placa})`, getClientIp(req));
  res.json({ message: 'Veículo atualizado.' });
});

// Veículo usado em caravana não some: só é desativado (preserva o histórico)
app.delete('/api/veiculos/:id', somenteAdmin, async (req, res) => {
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM caravanas WHERE veiculo_id = ?', [req.params.id]);
  if (Number(total) > 0) {
    await pool.query('UPDATE veiculos SET ativo = 0 WHERE id = ?', [req.params.id]);
    await registrarAuditoria(req.usuario.id, 'veiculo_desativado', `Veículo #${req.params.id}`, getClientIp(req));
    return res.json({ message: 'Veículo tem caravanas no histórico e foi desativado.' });
  }
  const [r] = await pool.query('DELETE FROM veiculos WHERE id = ?', [req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Veículo não encontrado.' });
  await registrarAuditoria(req.usuario.id, 'veiculo_removido', `Veículo #${req.params.id}`, getClientIp(req));
  res.json({ message: 'Veículo removido.' });
});

app.post('/api/veiculos/:id/foto', somenteAdmin, uploadImage.single('foto'), async (req, res) => {
  try {
    const [[veiculo]] = await pool.query('SELECT id, placa FROM veiculos WHERE id = ?', [req.params.id]);
    if (!veiculo) return res.status(404).json({ error: 'Veículo não encontrado.' });
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const { objectName, url } = await salvarImagem(VEICULO_BUCKET, `veiculo_${veiculo.id}_${veiculo.placa}`, req.file);
    await pool.query('UPDATE veiculos SET foto_url = ? WHERE id = ?', [url, veiculo.id]);
    await registrarAuditoria(req.usuario.id, 'foto_veiculo_enviada', `Foto do veículo ${veiculo.placa} salva no MinIO: ${objectName}`, getClientIp(req));
    res.json({ url });
  } catch (err) {
    console.error('[MinIO] Erro upload foto veículo:', err);
    res.status(500).json({ error: 'Erro ao enviar a foto do veículo.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RESERVAS (passagem = viagem + ingresso). Cada passageiro só vê as próprias.
// ─────────────────────────────────────────────────────────────────────────────
const SELECT_RESERVA = `
  SELECT r.*, c.cidade_saida, c.ponto_encontro, c.data_saida, c.status AS caravana_status,
         e.titulo, e.modalidade, e.local_nome, e.cidade_destino, e.data_evento, e.escudo_mandante, e.escudo_visitante,
         v.tipo AS veiculo_tipo, v.modelo AS veiculo_modelo, cp.codigo AS cupom_codigo,
         u.nome AS passageiro_nome, u.email AS passageiro_email
    FROM reservas r
    JOIN caravanas c ON c.id = r.caravana_id
    JOIN eventos e   ON e.id = c.evento_id
    JOIN veiculos v  ON v.id = c.veiculo_id
    JOIN usuarios u  ON u.id = r.usuario_id
    LEFT JOIN cupons cp ON cp.id = r.cupom_id`;

app.get('/api/reservas', autenticado, async (req, res) => {
  try {
    // Admin pode pedir todas (?todas=1); qualquer outro papel vê só as suas
    const todas = req.usuario.role === 'admin' && req.query.todas === '1';
    const [rows] = todas
      ? await pool.query(`${SELECT_RESERVA} ORDER BY r.criado_em DESC LIMIT 300`)
      : await pool.query(`${SELECT_RESERVA} WHERE r.usuario_id = ? ORDER BY c.data_saida DESC`, [req.usuario.id]);
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

    if (reserva.usuario_id !== req.usuario.id && req.usuario.role !== 'admin') {
      await registrarAuditoria(req.usuario.id, 'tentativa_acesso_reserva_alheia',
        `Tentou abrir a reserva #${req.params.id}, que pertence ao usuário #${reserva.usuario_id}`, getClientIp(req));
      return res.status(403).json({ error: 'Esta reserva pertence a outro passageiro.' });
    }
    res.json(reserva);
  } catch (err) {
    console.error('[Reservas] Erro ao detalhar:', err);
    res.status(500).json({ error: 'Erro ao buscar reserva.' });
  }
});

app.post('/api/reservas', exigirPapel('passageiro', 'admin'), async (req, res) => {
  const ip = getClientIp(req);
  const caravanaId = Number(req.body.caravana_id);
  const codigoCupom = String(req.body.cupom || '').trim().toUpperCase();
  if (!caravanaId) return res.status(400).json({ error: 'caravana_id obrigatório.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Trava a linha da caravana: duas compras simultâneas não pegam o mesmo lugar
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
      'SELECT id FROM reservas WHERE caravana_id = ? AND usuario_id = ? AND status <> "cancelada"', [caravanaId, req.usuario.id]);
    if (ja) {
      await conn.rollback();
      return res.status(409).json({ error: 'Você já tem uma passagem nesta caravana.' });
    }

    // Primeiro assento livre
    const [ocupadosRows] = await conn.query(
      'SELECT assento FROM reservas WHERE caravana_id = ? AND assento IS NOT NULL', [caravanaId]);
    const ocupados = new Set(ocupadosRows.map(r => r.assento));
    let assento = null;
    for (let i = 1; i <= Number(caravana.capacidade); i++) {
      if (!ocupados.has(i)) { assento = i; break; }
    }
    if (!assento) {
      await conn.query('UPDATE caravanas SET status = "lotada" WHERE id = ?', [caravanaId]);
      await conn.commit();
      return res.status(409).json({ error: 'Caravana lotada.' });
    }

    const preco = calcularPreco(caravana);
    let desconto = 0;
    let cupom = null;
    if (codigoCupom) {
      if (!req.usuario.pro) {
        await conn.rollback();
        return res.status(403).json({ error: 'Cupons são um benefício do plano Pro.' });
      }
      const [[c]] = await conn.query('SELECT * FROM cupons WHERE codigo = ? FOR UPDATE', [codigoCupom]);
      // Cupom de outra pessoa é tratado como inexistente
      if (!c || c.usuario_id !== req.usuario.id) {
        await conn.rollback();
        return res.status(404).json({ error: 'Cupom não encontrado.' });
      }
      if (c.usado) { await conn.rollback(); return res.status(409).json({ error: 'Cupom já utilizado.' }); }
      if (c.validade < hojeSP()) { await conn.rollback(); return res.status(409).json({ error: 'Cupom vencido.' }); }
      // Desconto só na parte da viagem: o ingresso é repasse a preço de custo
      desconto = arred(preco.valor_viagem * Number(c.desconto_pct) / 100);
      cupom = c;
      await conn.query('UPDATE cupons SET usado = 1 WHERE id = ?', [c.id]);
    }

    const total = arred(preco.valor_passagem - desconto);
    const [r] = await conn.query(
      `INSERT INTO reservas (caravana_id, usuario_id, cupom_id, assento, valor_viagem, valor_ingresso, desconto, valor_total, concorre_brinde)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [caravanaId, req.usuario.id, cupom?.id || null, assento, preco.valor_viagem, preco.valor_ingresso, desconto, total,
       req.usuario.pro ? 1 : 0]
    );

    if (ocupados.size + 1 >= Number(caravana.capacidade)) {
      await conn.query('UPDATE caravanas SET status = "lotada" WHERE id = ?', [caravanaId]);
    }
    await conn.commit();

    await registrarAuditoria(req.usuario.id, 'vaga_reservada',
      `Reserva #${r.insertId}: assento ${assento} na caravana #${caravanaId} (${caravana.titulo}) por R$ ${total.toFixed(2)}`, ip);
    if (cupom) {
      await registrarAuditoria(req.usuario.id, 'cupom_aplicado',
        `Cupom ${cupom.codigo} (${cupom.desconto_pct}%) na reserva #${r.insertId}: -R$ ${desconto.toFixed(2)}`, ip);
    }
    res.status(201).json({ id: r.insertId, assento, valor_total: total, desconto });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[Reservas] Erro ao reservar:', err);
    res.status(500).json({ error: 'Erro ao reservar a passagem.' });
  } finally {
    conn.release();
  }
});

// Cancelar a própria reserva (libera o lugar e devolve o cupom)
app.delete('/api/reservas/:id', autenticado, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const [[reserva]] = await pool.query(
      'SELECT r.*, c.data_saida, c.status AS caravana_status FROM reservas r JOIN caravanas c ON c.id = r.caravana_id WHERE r.id = ?',
      [req.params.id]);
    if (!reserva) return res.status(404).json({ error: 'Reserva não encontrada.' });

    if (reserva.usuario_id !== req.usuario.id && req.usuario.role !== 'admin') {
      await registrarAuditoria(req.usuario.id, 'tentativa_negada_403',
        `Tentou cancelar a reserva #${req.params.id} de outro usuário (#${reserva.usuario_id})`, ip);
      return res.status(403).json({ error: 'Esta reserva pertence a outro passageiro.' });
    }
    if (reserva.status !== 'confirmada') return res.status(409).json({ error: `Reserva já está ${reserva.status}.` });
    if (reserva.data_saida <= agoraSP()) return res.status(409).json({ error: 'A caravana já saiu.' });

    await pool.query('UPDATE reservas SET status = "cancelada", assento = NULL WHERE id = ?', [reserva.id]);
    if (reserva.cupom_id) await pool.query('UPDATE cupons SET usado = 0 WHERE id = ?', [reserva.cupom_id]);
    if (reserva.caravana_status === 'lotada') await pool.query('UPDATE caravanas SET status = "aberta" WHERE id = ?', [reserva.caravana_id]);

    await registrarAuditoria(req.usuario.id, 'reserva_cancelada',
      `Reserva #${reserva.id} (caravana #${reserva.caravana_id}, assento ${reserva.assento}) cancelada`, ip);
    res.json({ message: 'Reserva cancelada.' });
  } catch (err) {
    console.error('[Reservas] Erro ao cancelar:', err);
    res.status(500).json({ error: 'Erro ao cancelar reserva.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CUPONS (benefício Pro)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/cupons', autenticado, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, codigo, desconto_pct, descricao, validade, usado FROM cupons WHERE usuario_id = ? ORDER BY usado, validade',
    [req.usuario.id]);
  res.json({ pro: req.usuario.pro, cupons: rows });
});

// ─────────────────────────────────────────────────────────────────────────────
// MOTORISTA — só as caravanas que ele dirige
// ─────────────────────────────────────────────────────────────────────────────
const somenteMotorista = exigirPapel('motorista', 'admin');

app.get('/api/motorista/caravanas', somenteMotorista, async (req, res) => {
  const [rows] = req.usuario.role === 'admin'
    ? await pool.query(`${SELECT_CARAVANA} WHERE c.status <> 'cancelada' ORDER BY c.data_saida`)
    : await pool.query(`${SELECT_CARAVANA} WHERE c.motorista_id = ? AND c.status <> 'cancelada' ORDER BY c.data_saida`, [req.usuario.id]);
  res.json(rows.map(r => montarCaravana(r, req.usuario)));
});

async function caravanaDoMotorista(req, res, caravanaId) {
  const [[c]] = await pool.query('SELECT id, motorista_id FROM caravanas WHERE id = ?', [caravanaId]);
  if (!c) { res.status(404).json({ error: 'Caravana não encontrada.' }); return null; }
  if (req.usuario.role !== 'admin' && c.motorista_id !== req.usuario.id) {
    await registrarAuditoria(req.usuario.id, 'tentativa_negada_403',
      `Motorista tentou acessar a caravana #${caravanaId}, que não é dele`, getClientIp(req));
    res.status(403).json({ error: 'Você não é o motorista desta caravana.' });
    return null;
  }
  return c;
}

app.get('/api/motorista/caravanas/:id/passageiros', somenteMotorista, async (req, res) => {
  const c = await caravanaDoMotorista(req, res, req.params.id);
  if (!c) return;
  const [rows] = await pool.query(
    `SELECT r.id, r.assento, r.status, u.nome
       FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.caravana_id = ? AND r.status <> 'cancelada'
      ORDER BY r.assento`, [c.id]);
  res.json(rows);
});

app.post('/api/motorista/reservas/:id/embarque', somenteMotorista, async (req, res) => {
  const [[r]] = await pool.query('SELECT id, caravana_id, status, assento FROM reservas WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Reserva não encontrada.' });
  const c = await caravanaDoMotorista(req, res, r.caravana_id);
  if (!c) return;
  if (r.status !== 'confirmada') return res.status(409).json({ error: `Reserva está ${r.status}.` });
  await pool.query('UPDATE reservas SET status = "embarcou" WHERE id = ?', [r.id]);
  await registrarAuditoria(req.usuario.id, 'passageiro_embarcou', `Reserva #${r.id}, assento ${r.assento}, caravana #${r.caravana_id}`, getClientIp(req));
  res.json({ message: 'Embarque confirmado.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — papéis, cupons, brindes e auditoria
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
      { role: req.body.role, admin_id: req.usuario.id },
      { headers: { 'x-forwarded-for': getClientIp(req) } });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Erro ao alterar papel.' });
  }
});

app.post('/api/admin/cupons', somenteAdmin, async (req, res) => {
  const usuarioId = Number(req.body.usuario_id);
  const pct = Number(req.body.desconto_pct);
  const dias = Number(req.body.dias_validade) || 60;
  if (!usuarioId || !(pct > 0 && pct <= 50)) return res.status(400).json({ error: 'Informe o usuário e um desconto entre 1 e 50%.' });
  const [[u]] = await pool.query('SELECT id, premium, role FROM usuarios WHERE id = ?', [usuarioId]);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (!(u.premium == 1 || u.role === 'admin')) return res.status(400).json({ error: 'Cupons são exclusivos para assinantes Pro.' });
  const cupom = await gerarCupom(usuarioId, pct, String(req.body.descricao || 'Cupom do organizador').slice(0, 160), dias);
  await registrarAuditoria(req.usuario.id, 'cupom_gerado', `Cupom ${cupom.codigo} (${pct}%) para usuário #${usuarioId}`, getClientIp(req));
  res.status(201).json(cupom);
});

// Sorteia um brinde entre os passageiros Pro de uma caravana
app.post('/api/admin/caravanas/:id/sortear-brinde', somenteAdmin, async (req, res) => {
  const brinde = String(req.body.brinde || 'Camisa oficial').trim().slice(0, 160);
  const [candidatos] = await pool.query(
    `SELECT r.id, r.usuario_id, u.nome FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.caravana_id = ? AND r.status <> 'cancelada' AND r.concorre_brinde = 1 AND r.brinde IS NULL`, [req.params.id]);
  if (!candidatos.length) return res.status(409).json({ error: 'Nenhum passageiro Pro elegível nesta caravana.' });
  const ganhador = candidatos[crypto.randomInt(candidatos.length)];
  await pool.query('UPDATE reservas SET brinde = ? WHERE id = ?', [brinde, ganhador.id]);
  await registrarAuditoria(req.usuario.id, 'brinde_sorteado',
    `"${brinde}" para ${ganhador.nome} (reserva #${ganhador.id}, caravana #${req.params.id})`, getClientIp(req));
  res.json({ ganhador: ganhador.nome, reserva_id: ganhador.id, brinde });
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

// Healthcheck simples (usado pelo Docker)
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Erros de upload (multer), validações e exceções viram JSON
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
app.listen(PORT, () => console.log(`Caravanas Hub rodando na porta ${PORT}`));
