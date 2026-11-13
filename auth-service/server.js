require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const LOG_SERVICE_URL = process.env.LOG_SERVICE_URL || 'http://log-service:3002';

// Função para obter o IP do cliente
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

// Função para enviar eventos para o microsserviço de auditoria
async function registrarAuditoria(usuario_id, acao, detalhes = '', ip = '') {
  try {
    await fetch(`${LOG_SERVICE_URL}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario_id, acao, detalhes, ip })
    });
  } catch (error) {
    console.error('Erro ao enviar log para auditoria:', error.message);
  }
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false, // Brevo na porta 587 usa STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Cadastro (Blindado contra Mass Assignment)
app.post('/register', async (req, res) => {
  const { nome, email, senha, time_torcida } = req.body;
  if (!nome || !email || !senha) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const clientIp = getClientIp(req);

  try {
    // Todo cadastro público nasce como passageiro no plano Free; outros papéis só o admin atribui
    const papel = 'passageiro';
    const hash = await bcrypt.hash(senha, 12);
    const [result] = await pool.query(
      'INSERT INTO contas (nome, email, senha_hash, papel, time_torcida) VALUES (?, ?, ?, ?, ?)',
      [nome.trim(), email.trim().toLowerCase(), hash, papel, time_torcida ? String(time_torcida).trim().slice(0, 100) : null]
    );
    await pool.query('INSERT IGNORE INTO usuarios_free (conta_id) VALUES (?)', [result.insertId]);

    await registrarAuditoria(result.insertId, 'cadastro_sucesso', `Novo usuário cadastrado: ${email}`, clientIp);

    res.status(201).json({ id: result.insertId, nome, email, role: papel, papel });
  } catch (err) {
    console.error('Erro no register:', err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'E-mail já cadastrado.' });
    res.status(500).json({ error: 'Erro ao registrar.' });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { email, senha, via_atalho_f2 } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  const clientIp = getClientIp(req);
  const viaAtalhoF2 = Boolean(via_atalho_f2);

  try {
    const [rows] = await pool.query('SELECT * FROM contas WHERE email = ?', [email.trim().toLowerCase()]);
    if (rows.length === 0) {
      // FALHA: Usuário não encontrado
      await registrarAuditoria('anonimo', 'login_falha', `E-mail inexistente: ${email}`, clientIp);
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(senha, user.senha_hash);
    if (!match) {
      // FALHA: Senha incorreta
      await registrarAuditoria(user.id, 'login_falha', `Senha incorreta para o email ${user.email}`, clientIp);
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    if (user.papel === 'admin' && !viaAtalhoF2) {
      await registrarAuditoria(user.id, 'login_admin_bloqueado', `Tentativa de login de admin (${user.email}) na tela comum bloqueada`, clientIp);
      return res.status(403).json({ error: 'O login de administrador só é permitido pelo atalho exclusivo na página inicial.' });
    }

    if (viaAtalhoF2 && user.papel !== 'admin') {
      await registrarAuditoria(user.id, 'login_f2_negado', `Conta sem privilégio admin (${user.email}) tentou autenticar pelo atalho F2`, clientIp);
      return res.status(403).json({ error: 'Este atalho é exclusivo para administradores.' });
    }

    // SUCESSO!
    await registrarAuditoria(user.id, 'login_sucesso', `Sessão iniciada pelo email ${user.email} (${user.papel}${viaAtalhoF2 ? ' via F2' : ''})`, clientIp);
    res.json({ id: user.id, nome: user.nome, email: user.email, role: user.papel, papel: user.papel, time_torcida: user.time_torcida });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: 'Erro no login.' });
  }
});

// Solicitar Recuperação de Senha (Brevo)
app.post('/forgot-password', async (req, res) => {
  const { email, baseUrl } = req.body;
  if (!email) return res.status(400).json({ error: 'Informe o e-mail.' });

  const clientIp = getClientIp(req);

  try {
    const [users] = await pool.query('SELECT id, nome FROM contas WHERE email = ?', [email.trim().toLowerCase()]);
    if (users.length === 0) {
      return res.json({ message: 'Se o e-mail existir, o link de recuperação foi enviado.' });
    }

    const user = users[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiraEm = new Date(Date.now() + 30 * 60 * 1000); // 30 minutos

    await pool.query(
      'INSERT INTO reset_tokens (token, usuario_id, expira_em) VALUES (?, ?, ?)',
      [token, user.id, expiraEm]
    );

    const appUrl = baseUrl || process.env.APP_URL || 'https://yago-martins-isw055.lapps.studio';
    const resetLink = `${appUrl}/reset-password.html?token=${token}`;

    await transporter.sendMail({
      from: '"Caravanas Hub" <yagofelipeoliveira3@gmail.com>',
      to: email,
      subject: 'Recuperação de Senha',
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h2>Redefinição de Senha</h2>
          <p>Olá, <strong>${user.nome}</strong>!</p>
          <p>Você solicitou a recuperação da sua senha no Caravanas Hub.</p>
          <p><a href="${resetLink}" style="background-color: #16a34a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Redefinir Minha Senha</a></p>
          <p>Este link expira em <strong>30 minutos</strong> e só pode ser usado uma vez.</p>
        </div>
      `
    });

    await registrarAuditoria(user.id, 'solicitacao_recuperacao_senha', `Solicitou link de recuperação para ${email}`, clientIp);

    res.json({ message: 'Se o e-mail existir, o link de recuperação foi enviado.' });
  } catch (err) {
    console.error('ERRO DETALHADO NO FORGOT-PASSWORD:', err);
    res.status(500).json({ error: 'Erro ao processar recuperação.' });
  }
});

// Redefinir Senha
app.post('/reset-password', async (req, res) => {
  const { token, novaSenha } = req.body;
  if (!token || !novaSenha || novaSenha.length < 6) {
    return res.status(400).json({ error: 'Token inválido ou senha com menos de 6 caracteres.' });
  }

  const clientIp = getClientIp(req);

  try {
    const [rows] = await pool.query(
      'SELECT * FROM reset_tokens WHERE token = ? AND usado = FALSE AND expira_em > NOW()',
      [token]
    );

    if (rows.length === 0) {
      await registrarAuditoria('anonimo', 'reset_senha_falha', 'Tentativa de uso de token inválido/expirado', clientIp);
      return res.status(400).json({ error: 'Token inválido, já utilizado ou expirado após 30 minutos.' });
    }

    const resetRecord = rows[0];
    const hash = await bcrypt.hash(novaSenha, 12);

    await pool.query('UPDATE contas SET senha_hash = ? WHERE id = ?', [hash, resetRecord.usuario_id]);
    await pool.query('UPDATE reset_tokens SET usado = TRUE WHERE id = ?', [resetRecord.id]);

    await registrarAuditoria(resetRecord.usuario_id, 'senha_redefinida', 'Usuário redefiniu a senha com sucesso via token', clientIp);

    res.json({ message: 'Senha atualizada com sucesso!' });
  } catch (err) {
    console.error('Erro no reset-password:', err);
    res.status(500).json({ error: 'Erro ao atualizar senha.' });
  }
});

// Alterar Senha (chamado internamente pelo caravanas-service com usuario_id da sessão)
app.post('/change-password', async (req, res) => {
  // SEGURANÇA: usuario_id vem do caravanas-service (da sessão), não do body do usuário
  const { usuario_id, novaSenha } = req.body;
  if (!usuario_id || !novaSenha || novaSenha.length < 6) {
    return res.status(400).json({ error: 'Dados inválidos.' });
  }
  try {
    const hash = await bcrypt.hash(novaSenha, 12);
    await pool.query('UPDATE contas SET senha_hash = ? WHERE id = ?', [hash, usuario_id]);
    res.json({ message: 'Senha alterada com sucesso!' });
  } catch (err) {
    console.error('Erro no change-password:', err);
    res.status(500).json({ error: 'Erro ao alterar senha.' });
  }
});

// ─── Papéis do negócio ───────────────────────────────────────────────────────
// admin       → gerencia tudo (inclusive corridas de F1), cria cupons e sorteia brindes
// organizador → responsável pela van/ônibus, cria e gerencia suas próprias caravanas
// passageiro  → compra passagens e vê só as próprias reservas (Pro = usuarios_premium ativo)
const PAPEIS_VALIDOS = ['admin', 'organizador', 'passageiro'];

// Listar usuários e papéis (chamado pelo caravanas-service, já protegido por adminMiddleware)
app.get('/users', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.nome, c.email, c.papel AS role, c.papel, c.time_torcida,
             (CASE WHEN up.conta_id IS NOT NULL AND up.ativo = 1 THEN 1 ELSE 0 END) AS premium
        FROM contas c
        LEFT JOIN usuarios_premium up ON up.conta_id = c.id
       ORDER BY c.nome
    `);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao listar usuários:', err);
    res.status(500).json({ error: 'Erro ao listar usuários.' });
  }
});

// Alterar papel de um usuário (chamado pelo caravanas-service, já protegido por adminMiddleware)
app.put('/users/:id/role', async (req, res) => {
  const { role, admin_id } = req.body;
  const alvoId = Number(req.params.id);
  if (!PAPEIS_VALIDOS.includes(role)) {
    return res.status(400).json({ error: `Papel inválido. Use: ${PAPEIS_VALIDOS.join(', ')}.` });
  }
  if (Number(admin_id) === alvoId && role !== 'admin') {
    return res.status(400).json({ error: 'Você não pode remover o próprio papel de admin.' });
  }
  try {
    const [result] = await pool.query('UPDATE contas SET papel = ? WHERE id = ?', [role, alvoId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (role === 'organizador' || role === 'admin') {
      await pool.query('INSERT IGNORE INTO organizadores (conta_id) VALUES (?)', [alvoId]);
    }
    await registrarAuditoria(admin_id, 'papel_alterado', `Conta #${alvoId} agora tem papel ${role}`, getClientIp(req));
    res.json({ id: alvoId, role, papel: role });
  } catch (err) {
    console.error('Erro ao alterar papel:', err);
    res.status(500).json({ error: 'Erro ao alterar papel.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Auth Service rodando internamente na porta ${PORT}`));