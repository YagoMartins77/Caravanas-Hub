// Caravana's Hub — app do passageiro, organizador e administrador
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const estado = { me: null, meta: null, tipo: '', cidade: '', cache: {} };

// ─── Utilidades ──────────────────────────────────────────────────────────────
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
function dataBR(s) {
  if (!s) return '-';
  const [d, h = ''] = String(s).replace('T', ' ').split(' ');
  const [y, m, dia] = d.split('-');
  return `${dia}/${m}/${y}${h ? ' ' + h.slice(0, 5) : ''}`;
}
const paraInput = (s) => (s ? String(s).replace(' ', 'T').slice(0, 16) : '');
const MOD = {
  futebol: { nome: 'Futebol', ico: 'fa-futbol' },
  corrida: { nome: 'Fórmula 1', ico: 'fa-flag-checkered' },
  mma: { nome: 'MMA', ico: 'fa-hand-fist' }
};
const STATUS_PAGAMENTO = {
  pendente: ['Aguardando pagamento', 'badge-pro'],
  pago: ['Pago · Confirmada', 'badge-ok'],
  cancelado: ['Cancelada', 'badge-bad']
};

function toast(msg, tipo = 'ok') {
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

async function api(url, opts = {}) {
  const o = { ...opts, headers: { ...(opts.headers || {}) } };
  if (o.body && !(o.body instanceof FormData)) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(o.body);
  }
  const res = await fetch(url, o);
  if (res.status === 401) { window.location.href = 'auth.html'; throw new Error('Sessão expirada.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Erro ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

function abrirModal(html, wide = false) {
  $('#modalBox').className = `modal-box${wide ? ' wide' : ''}`;
  $('#modalBox').innerHTML = `<button class="modal-close" data-action="fechar-modal"><i class="fas fa-xmark"></i></button>${html}`;
  $('#modal').classList.add('open');
}
function fecharModal() { $('#modal').classList.remove('open'); }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') fecharModal(); });

const temPapel = (...p) => p.includes(estado.me?.papel || estado.me?.role);
const ehPro = () => estado.me?.premium == 1;

// ─── Navegação ───────────────────────────────────────────────────────────────
const carregadores = {
  caravanas: carregarCaravanas,
  passagens: carregarPassagens,
  pro: carregarPro,
  organizador: carregarOrganizador,
  admin: () => abrirAbaAdmin($('#adminTabs .tab.active')?.dataset.tab || 'a-caravanas')
};

function irPara(view) {
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${view}`));
  $$('#navLinks a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  carregadores[view]?.();
}

// ─── Sessão / topo ───────────────────────────────────────────────────────────
async function carregarMe() {
  estado.me = await api('/api/auth/me');
  const me = estado.me;
  const papel = me.papel || me.role;
  $('#badgePlano').innerHTML = ehPro()
    ? '<span class="badge badge-pro"><i class="fas fa-crown"></i> Pro</span>'
    : '<a class="badge" data-view="pro" style="cursor:pointer">Free · seja Pro</a>';
  $('#badgePapel').innerHTML = papel === 'passageiro' ? '' :
    `<span class="badge badge-${papel === 'admin' ? 'admin' : 'motorista'}">${papel === 'admin' ? 'Admin' : 'Organizador'}</span>`;
  $('#linkOrganizador').classList.toggle('hidden', !temPapel('organizador', 'admin'));
  $('#linkAdmin').classList.toggle('hidden', !temPapel('admin'));

  // Atualiza botão do time/esporte no cabeçalho
  const time = me.time_torcida;
  const labelTime = $('#labelMeuTime');
  const icoTime = $('#icoMeuTime');
  if (labelTime) {
    labelTime.textContent = time ? time : 'Meu Time';
  }
  if (icoTime) {
    if (time && /corrida|f1|fórmula/i.test(time)) icoTime.className = 'fas fa-flag-checkered';
    else if (time && /mma|luta/i.test(time)) icoTime.className = 'fas fa-hand-fist';
    else icoTime.className = 'fas fa-futbol';
  }

  const box = $('#avatarBox');
  const img = box.querySelector('img');
  if (me.avatar_url) {
    if (img) img.src = me.avatar_url; else box.insertAdjacentHTML('afterbegin', `<img src="${esc(me.avatar_url)}" class="avatar" alt="">`);
    $('#avatarInicial').classList.add('hidden');
  } else {
    $('#avatarInicial').textContent = (me.nome || '?').charAt(0).toUpperCase();
  }
}

$('#avatarInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('avatar', f);
  try {
    await api('/api/perfil/avatar', { method: 'POST', body: fd });
    toast('Foto atualizada!');
    carregarMe();
  } catch (err) { toast(err.message, 'err'); }
});

$('#btnSair').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

// ─── Caravanas (vitrine) ─────────────────────────────────────────────────────
function capa(c) {
  const futebolComEscudo = c.evento_tipo === 'futebol' && c.escudo_mandante && c.escudo_visitante;
  const miolo = futebolComEscudo
    ? `<div class="escudos"><img src="${esc(c.escudo_mandante)}" alt="" onerror="this.outerHTML='<i class=\\'fas fa-shield-halved fa-2x\\' style=\\'color:var(--green)\\'></i>'"><span>X</span><img src="${esc(c.escudo_visitante)}" alt="" onerror="this.outerHTML='<i class=\\'fas fa-shield-halved fa-2x\\' style=\\'color:var(--green)\\'></i>'"></div>`
    : `<i class="fas ${MOD[c.evento_tipo]?.ico || 'fa-bus'} cover-ico"></i>`;
  const timeTorcida = (estado.me?.time_torcida || '').toLowerCase();
  const matchTime = Boolean(timeTorcida && c.evento_nome && c.evento_nome.toLowerCase().includes(timeTorcida));

  return `
    <div class="card-cover ${esc(c.evento_tipo)}">
      <div class="tags">
        <span class="badge badge-${esc(c.evento_tipo)}">${MOD[c.evento_tipo]?.nome || ''}</span>
        ${matchTime ? '<span class="badge badge-destaque" style="background:rgba(34,197,94,.18);color:var(--green);border:1px solid var(--green);"><i class="fas fa-star"></i> Recomendado para você</span>' : ''}
        ${c.exclusiva_pro_agora ? '<span class="badge badge-pro"><i class="fas fa-bolt"></i> Pré-venda Pro</span>' : ''}
        ${c.status !== 'aberta' ? `<span class="badge badge-bad">${esc(c.status)}</span>` : ''}
      </div>
      ${miolo}
      ${c.foto_url ? `<img class="veic-thumb" src="${esc(c.foto_url)}" alt="Veículo">` : ''}
    </div>`;
}

function cardCaravana(c, botoesHtml) {
  const pct = Math.min(100, Math.round((c.ocupados / c.vagas_totais) * 100));
  const timeTorcida = (estado.me?.time_torcida || '').toLowerCase();
  const matchTime = Boolean(timeTorcida && c.evento_nome && c.evento_nome.toLowerCase().includes(timeTorcida));

  return `
    <article class="card ${matchTime ? 'destaque-time' : ''}">
      ${capa(c)}
      <div class="card-body">
        <h3>${esc(c.evento_nome)}</h3>
        <div class="meta"><i class="fas fa-location-dot"></i>Saída: <strong>${esc(c.cidade_saida)}</strong> · ${dataBR(c.data_saida)}</div>
        <div class="meta"><i class="fas fa-flag"></i>${esc(c.evento_local)}</div>
        <div class="meta"><i class="fas fa-bus"></i>${esc(c.descricao_frota || c.organizador_nome)}</div>
        <div class="meta small" style="justify-content:space-between;margin-top:.3rem;"><span>${c.vagas_livres} vaga(s) de ${c.vagas_totais}</span><span>${pct}%</span></div>
        <div class="vagas-bar"><div style="width:${pct}%"></div></div>
      </div>
      <div class="card-foot">
        <div class="price-tag">${brl(c.preco)}<small>viagem + ingresso</small></div>
        <div style="display:flex;gap:.4rem;">${botoesHtml || `<button class="btn btn-primary btn-sm" data-action="detalhe" data-id="${c.id}">Ver detalhes</button>`}</div>
      </div>
    </article>`;
}

async function carregarCaravanas() {
  const lista = $('#listaCaravanas');
  lista.innerHTML = '<p class="muted">Carregando...</p>';
  try {
    const qs = new URLSearchParams();
    if (estado.tipo) qs.set('tipo', estado.tipo);
    if (estado.cidade) qs.set('cidade', estado.cidade);
    const data = await api(`/api/caravanas?${qs}`);

    $('#bannerPro').innerHTML = (!ehPro() && data.exclusivas_pro_ocultas > 0) ? `
      <div class="banner-pro">
        <div><i class="fas fa-lock" style="color:var(--gold)"></i>
          <strong>${data.exclusivas_pro_ocultas} caravana(s) em pré-venda exclusiva Pro</strong>.
          Assinantes compram ${data.antecedencia_pro_dias} dias antes do Free.</div>
        <button class="btn btn-gold btn-sm" data-view="pro">Quero ser Pro</button>
      </div>` : '';

    lista.innerHTML = data.caravanas.length
      ? data.caravanas.map(c => cardCaravana(c)).join('')
      : '<div class="empty" style="grid-column:1/-1"><i class="fas fa-road"></i>Nenhuma caravana disponível com esses filtros agora.</div>';
  } catch (err) {
    lista.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

$('#filtrosTipo').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $$('#filtrosTipo .chip').forEach(c => c.classList.toggle('active', c === chip));
  estado.tipo = chip.dataset.tipo;
  carregarCaravanas();
});
$('#filtroCidade').addEventListener('change', (e) => { estado.cidade = e.target.value; carregarCaravanas(); });

// ─── Sub-abas: Caravanas vs Jogos Série A ─────────────────────────────────────
$('#subtabCaravanas')?.addEventListener('click', () => {
  $('#subtabCaravanas').classList.add('active');
  $('#subtabJogosSerieA').classList.remove('active');
  $('#secaoCaravanasVitrine').classList.remove('hidden');
  $('#secaoJogosSerieA').classList.add('hidden');
  $('#secaoFiltroCidade').style.display = 'block';
});

$('#subtabJogosSerieA')?.addEventListener('click', () => {
  $('#subtabJogosSerieA').classList.add('active');
  $('#subtabCaravanas').classList.remove('active');
  $('#secaoCaravanasVitrine').classList.add('hidden');
  $('#secaoJogosSerieA').classList.remove('hidden');
  $('#secaoFiltroCidade').style.display = 'none';
  carregarJogosSerieAApp();
});

$('#btnAtualizarJogosApp')?.addEventListener('click', carregarJogosSerieAApp);

async function carregarJogosSerieAApp() {
  const lista = $('#listaJogosSerieAApp');
  lista.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2rem;"><i class="fas fa-spinner fa-spin fa-2x"></i><p style="margin-top:.8rem;">Carregando jogos oficiais do Brasileirão...</p></div>';
  try {
    const data = await api('/api/futebol/serie-a-jogos');
    const jogos = data.jogos || [];
    if (data.rodada_nome) {
      $('#subtituloJogosApp').innerHTML = `<i class="fas fa-trophy" style="color:var(--green)"></i> <strong>${esc(data.competicao)} (${esc(data.rodada_nome)})</strong> — Dados oficiais API Futebol.`;
    }
    if (!jogos.length) {
      lista.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2rem;" class="muted">Nenhum jogo retornado no momento.</div>';
      return;
    }
    lista.innerHTML = jogos.map(j => {
      const statusCaravana = j.tem_caravana
        ? `
          <div style="margin-top:.8rem;padding-top:.8rem;border-top:1px solid var(--line);">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span class="badge badge-ok"><i class="fas fa-check-circle"></i> Caravana confirmada</span>
              <strong style="color:var(--green);font-size:1.05rem;">${brl(j.caravana.preco)}</strong>
            </div>
            <div class="small muted" style="margin:.4rem 0;"><i class="fas fa-location-dot"></i> Saída de <strong>${esc(j.caravana.cidade_saida)}</strong> · ${j.caravana.vagas_livres} vagas restantes</div>
            <button class="btn btn-primary btn-sm" style="width:100%;margin-top:.4rem;" data-action="detalhe" data-id="${j.caravana.id}"><i class="fas fa-ticket"></i> Ver Caravana e Reservar</button>
          </div>`
        : `
          <div style="margin-top:.8rem;padding-top:.8rem;border-top:1px solid var(--line);">
            <span class="badge badge-sem-caravana" style="display:block;text-align:center;padding:.5rem;border-radius:10px;font-size:.82rem;font-weight:600;">
              <i class="fas fa-circle-exclamation"></i> Sem ingressos/caravana disponível para este evento
            </span>
          </div>`;

      return `
        <div class="jogo-card">
          <div class="jogo-header">
            <span><i class="fas fa-trophy" style="color:var(--green)"></i> ${esc(j.competicao || 'Brasileirão Série A')}</span>
            <span><i class="fas fa-calendar-day"></i> ${dataBR(j.data_iso)}</span>
          </div>
          <div class="jogo-placar">
            <div class="jogo-time">
              ${j.escudo_mandante ? `<img src="${esc(j.escudo_mandante)}" alt="${esc(j.mandante)}" onerror="this.outerHTML='<i class=\\'fas fa-shield-halved fa-2x\\' style=\\'color:var(--green)\\'></i>'">` : '<i class="fas fa-shield-halved fa-2x" style="color:var(--green)"></i>'}
              <span>${esc(j.mandante)}</span>
            </div>
            <div class="jogo-vs">VS</div>
            <div class="jogo-time">
              ${j.escudo_visitante ? `<img src="${esc(j.escudo_visitante)}" alt="${esc(j.visitante)}" onerror="this.outerHTML='<i class=\\'fas fa-shield-halved fa-2x\\' style=\\'color:var(--green)\\'></i>'">` : '<i class="fas fa-shield-halved fa-2x" style="color:var(--green)"></i>'}
              <span>${esc(j.visitante)}</span>
            </div>
          </div>
          <div class="jogo-info">
            <span><i class="fas fa-location-dot"></i> Estádio: <strong>${esc(j.estadio || 'A definir')}</strong></span>
          </div>
          ${statusCaravana}
        </div>
      `;
    }).join('');
  } catch (err) {
    lista.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:2rem;color:#f87171;"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
  }
}

// ─── Modal Onboarding / Editar Meu Time ──────────────────────────────────────
let timesSerieAApp = [];
function abrirModalMeuTime() {
  const m = $('#modalMeuTime');
  if (!m) return;
  m.classList.add('open');
  mostrarStep1App();
  carregarTimesSerieAApp();
}
window.abrirModalMeuTime = abrirModalMeuTime;
function fecharModalMeuTime() {
  $('#modalMeuTime')?.classList.remove('open');
}
$('#btnFecharModalMeuTime')?.addEventListener('click', fecharModalMeuTime);
$('#modalMeuTime')?.addEventListener('click', (e) => { if (e.target.id === 'modalMeuTime') fecharModalMeuTime(); });

function mostrarStep1App() {
  const s1 = $('#stepEsporteApp');
  const s2 = $('#stepTimeApp');
  if (!s1 || !s2) return;
  s1.style.display = 'block';
  s1.style.opacity = '1';
  s1.style.transform = 'translateX(0)';
  s1.className = 'anim-step anim-step-active';
  s2.style.display = 'none';
  s2.style.opacity = '0';
}

function mostrarStep2App() {
  const s1 = $('#stepEsporteApp');
  const s2 = $('#stepTimeApp');
  s1.className = 'anim-step slide-out-left';
  setTimeout(() => {
    s1.style.display = 'none';
    s2.style.display = 'block';
    s2.style.opacity = '0';
    s2.style.transform = 'translateX(40px)';
    void s2.offsetWidth;
    s2.style.transition = 'opacity .25s ease, transform .25s ease';
    s2.style.opacity = '1';
    s2.style.transform = 'translateX(0)';
  }, 200);
}

$('#btnVoltarEsporteApp')?.addEventListener('click', () => {
  const s1 = $('#stepEsporteApp');
  const s2 = $('#stepTimeApp');
  s2.style.transition = 'opacity .2s ease, transform .2s ease';
  s2.style.opacity = '0';
  s2.style.transform = 'translateX(40px)';
  setTimeout(() => {
    s2.style.display = 'none';
    s1.style.display = 'block';
    s1.style.opacity = '0';
    s1.style.transform = 'translateX(-40px)';
    void s1.offsetWidth;
    s1.style.transition = 'opacity .25s ease, transform .25s ease';
    s1.style.opacity = '1';
    s1.style.transform = 'translateX(0)';
  }, 200);
});

$('#btnAppFutebol')?.addEventListener('click', mostrarStep2App);
$('#btnAppCorrida')?.addEventListener('click', () => salvarTimeApp('Fórmula 1'));
$('#btnAppMMA')?.addEventListener('click', () => salvarTimeApp('MMA'));

async function carregarTimesSerieAApp() {
  if (timesSerieAApp.length) { renderizarTimesApp(timesSerieAApp); return; }
  try {
    timesSerieAApp = await api('/api/futebol/serie-a-times');
    renderizarTimesApp(timesSerieAApp);
  } catch (err) {
    $('#gridTimesApp').innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#f87171;">Não foi possível listar os clubes agora. Digite seu time na busca acima.</div>';
  }
}

function renderizarTimesApp(lista) {
  const grid = $('#gridTimesApp');
  if (!lista.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:1.5rem;">Nenhum clube encontrado com este nome.</div>';
    return;
  }
  const torcidaAtual = (estado.me?.time_torcida || '').toLowerCase();
  grid.innerHTML = lista.map(t => {
    const isSelected = torcidaAtual === t.nome.toLowerCase();
    return `
      <div class="time-item ${isSelected ? 'selected' : ''}" data-time="${esc(t.nome)}">
        <img src="${esc(t.escudo)}" alt="${esc(t.nome)}" loading="lazy" onerror="this.outerHTML='<div style=\\'width:44px;height:44px;border-radius:50%;background:rgba(34,197,94,.15);border:1px solid var(--green);display:grid;place-items:center;font-weight:800;font-size:.78rem;color:var(--green)\\'>${esc((t.sigla || t.nome || '').slice(0, 3).toUpperCase())}</div>'">
        <span>${esc(t.nome)}</span>
        ${isSelected ? '<i class="fas fa-check" style="color:var(--green)"></i>' : ''}
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.time-item').forEach(item => {
    item.addEventListener('click', () => salvarTimeApp(item.dataset.time));
  });
}

$('#inputBuscaTimeApp')?.addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const filtrados = timesSerieAApp.filter(t => t.nome.toLowerCase().includes(q) || (t.sigla && t.sigla.toLowerCase().includes(q)));
  renderizarTimesApp(filtrados);

  const customRow = $('#customTeamRowApp');
  if (q.length >= 2 && !timesSerieAApp.some(t => t.nome.toLowerCase() === q)) {
    customRow.style.display = 'flex';
    $('#customTeamNomeApp').textContent = e.target.value.trim();
  } else {
    customRow.style.display = 'none';
  }
});

$('#btnConfirmarCustomApp')?.addEventListener('click', () => {
  const nome = $('#inputBuscaTimeApp').value.trim();
  if (nome) salvarTimeApp(nome);
});
$('#inputBuscaTimeApp')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const nome = $('#inputBuscaTimeApp').value.trim();
    if (nome) salvarTimeApp(nome);
  }
});

async function salvarTimeApp(nome) {
  try {
    await api('/api/perfil/time', { method: 'PUT', body: { time_torcida: nome } });
    estado.me.time_torcida = nome;
    toast(`Preferência atualizada para ${nome}! Caravanas recomendadas em destaque.`);
    fecharModalMeuTime();
    await carregarMe();
    await carregarCaravanas();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ─── Detalhes e Reserva ──────────────────────────────────────────────────────
async function detalheCaravana(id) {
  try {
    const c = await api(`/api/caravanas/${id}`);
    const ingresso = Number(c.valor_ingresso || 0);
    const viagem = Math.max(0, Number(c.preco) - ingresso);
    const podeComprar = c.status === 'aberta' && c.vagas_livres > 0;
    abrirModal(`
      <span class="badge badge-${esc(c.evento_tipo)}">${MOD[c.evento_tipo]?.nome}</span>
      <h2 style="margin-top:.6rem;">${esc(c.evento_nome)}</h2>
      ${c.foto_url ? `<img src="${esc(c.foto_url)}" alt="Veículo" style="width:100%;max-height:240px;object-fit:cover;border-radius:12px;margin-bottom:1rem;">` : ''}
      <div class="meta"><i class="fas fa-calendar"></i>Evento: ${dataBR(c.data_evento)} · ${esc(c.evento_local)} (${esc(c.evento_pais)})</div>
      <div class="meta"><i class="fas fa-location-dot"></i>Embarque: <strong>${esc(c.local_saida)}</strong>, ${esc(c.cidade_saida)}</div>
      <div class="meta"><i class="fas fa-clock"></i>Saída: ${dataBR(c.data_saida)}</div>
      <div class="meta"><i class="fas fa-bus"></i>Organizador: ${esc(c.organizador_nome)}${c.descricao_frota ? ` · ${esc(c.descricao_frota)}` : ''}</div>
      <div class="meta"><i class="fas fa-chair"></i>${c.vagas_livres} de ${c.vagas_totais} vagas livres</div>

      <div class="price-breakdown">
        ${ingresso > 0 ? `
          <div class="row"><span>Viagem (ida e volta)</span><span>${brl(viagem)}</span></div>
          <div class="row"><span>Ingresso <span class="muted small">(repassado a preço de custo)</span></span><span>${brl(ingresso)}</span></div>` : ''}
        <div class="row total"><span>Passagem</span><span>${brl(c.preco)}</span></div>
      </div>

      ${podeComprar ? `
        ${ehPro() ? `
          <div class="field"><label for="cupomInput">Cupom Pro (opcional, desconto só na parte da viagem)</label>
          <input id="cupomInput" placeholder="PRO-XXXXXX" style="text-transform:uppercase"></div>` :
          '<p class="muted small" style="margin-bottom:.8rem;"><i class="fas fa-crown" style="color:var(--gold)"></i> Assinantes Pro usam cupons de desconto e concorrem a brindes.</p>'}
        <button class="btn btn-primary btn-lg" style="width:100%;" data-action="comprar" data-id="${c.id}">
          <i class="fab fa-cc-stripe"></i> Pagar com cartão (Stripe)
        </button>
        <p class="muted small" style="text-align:center;margin-top:.6rem;">
          Ambiente de teste: use o cartão 4242 4242 4242 4242, qualquer validade futura e CVC.<br>
          Sua vaga fica reservada por 30 minutos até o pagamento.
        </p>` :
        `<p class="muted" style="text-align:center;">${c.vagas_livres === 0 || c.status === 'lotada' ? 'Caravana lotada.' : `Caravana ${esc(c.status)}.`}</p>`}
    `);
  } catch (err) { toast(err.message, 'err'); }
}

async function comprar(id, botao) {
  botao.disabled = true;
  botao.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Abrindo checkout...';
  try {
    const cupom = $('#cupomInput')?.value.trim() || undefined;
    const r = await api('/api/reservas', { method: 'POST', body: { caravana_id: id, cupom } });
    window.location.href = r.pagamento_url;
  } catch (err) {
    toast(err.message, 'err');
    botao.disabled = false;
    botao.innerHTML = '<i class="fab fa-cc-stripe"></i> Pagar com cartão (Stripe)';
    if (err.data?.reserva_id) { fecharModal(); irPara('passagens'); }
  }
}

// ─── Passagens ───────────────────────────────────────────────────────────────
async function carregarPassagens() {
  const box = $('#listaPassagens');
  box.innerHTML = '<p class="muted">Carregando...</p>';
  try {
    const reservas = await api('/api/reservas');
    if (!reservas.length) {
      box.innerHTML = '<div class="empty"><i class="fas fa-ticket"></i>Você ainda não tem passagens. <a data-view="caravanas" style="cursor:pointer">Ver caravanas</a></div>';
      return;
    }
    box.innerHTML = reservas.map(r => {
      const [rot, cls] = STATUS_PAGAMENTO[r.status_pagamento] || [r.status_pagamento, ''];
      return `
      <div class="ticket">
        <div>
          <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.5rem;">
            <span class="badge badge-${esc(r.evento_tipo)}">${MOD[r.evento_tipo]?.nome}</span>
            <span class="badge ${cls}">${rot}</span>
          </div>
          <h3>${esc(r.evento_nome)}</h3>
          <div class="meta"><i class="fas fa-location-dot"></i>${esc(r.local_saida)}, ${esc(r.cidade_saida)} · saída ${dataBR(r.data_saida)}</div>
          <div class="meta"><i class="fas fa-flag"></i>${esc(r.evento_local)} · ${dataBR(r.data_evento)}</div>
          <div class="meta"><i class="fas fa-receipt"></i>Reserva #${r.id} · ${brl(r.valor_total || r.caravana_preco)}${Number(r.desconto) ? ` (cupom ${esc(r.cupom_codigo || '')}: -${brl(r.desconto)})` : ''}</div>
          ${r.status_pagamento === 'pendente' ? `<div class="meta small"><i class="fas fa-hourglass-half"></i>Vaga reservada até ${dataBR(r.expira_em)}</div>` : ''}
          <div style="display:flex;gap:.5rem;margin-top:.8rem;flex-wrap:wrap;">
            ${r.status_pagamento === 'pendente' ? `<button class="btn btn-primary btn-sm" data-action="pagar" data-id="${r.id}"><i class="fab fa-cc-stripe"></i> Pagar agora</button>` : ''}
            ${['pendente', 'pago'].includes(r.status_pagamento) ? `<button class="btn btn-danger btn-sm" data-action="cancelar-reserva" data-id="${r.id}" data-status="${r.status_pagamento}">Cancelar</button>` : ''}
          </div>
        </div>
        <div class="seat"><span class="muted small">RESERVA</span><b>#${r.id}</b></div>
      </div>`;
    }).join('');
  } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

async function pagarPendente(id) {
  try {
    const r = await api(`/api/reservas/${id}/pagamento`);
    window.location.href = r.pagamento_url;
  } catch (err) { toast(err.message, 'err'); carregarPassagens(); }
}

async function cancelarReserva(id, status) {
  const aviso = status === 'pago'
    ? 'Cancelar esta passagem? O valor será estornado no cartão pelo Stripe.'
    : 'Cancelar esta reserva pendente e liberar a vaga?';
  if (!confirm(aviso)) return;
  try {
    const r = await api(`/api/reservas/${id}`, { method: 'DELETE' });
    toast(r.message);
    carregarPassagens();
  } catch (err) { toast(err.message, 'err'); }
}

// ─── Pro, cupons e brindes ───────────────────────────────────────────────────
async function carregarPro() {
  const dias = estado.me.antecedencia_pro_dias || 3;
  $('#boxPro').innerHTML = ehPro() ? `
    <div class="plan pro" style="max-width:640px;">
      <h3><i class="fas fa-crown" style="color:var(--gold)"></i> Você é Pro</h3>
      <ul style="margin:1rem 0;">
        <li><i class="fas fa-bolt"></i> Vê e compra caravanas ${dias} dias antes do plano Free</li>
        <li><i class="fas fa-percent"></i> Recebe cupons de desconto do organizador</li>
        <li><i class="fas fa-gift"></i> Participa dos sorteios de brindes e prêmios</li>
      </ul>
      <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.4rem;">
        <button class="btn btn-danger btn-sm" data-action="cancelar-pro"><i class="fas fa-ban"></i> Cancelar assinatura Pro</button>
      </div>
    </div>` : `
    <div class="plan pro" style="max-width:640px;">
      <h3><i class="fas fa-crown" style="color:var(--gold)"></i> Caravana's Hub Pro</h3>
      <div class="price">R$ 19,90 <small>/ mês</small></div>
      <ul>
        <li><i class="fas fa-bolt"></i> <span><strong>Acesso antecipado:</strong> caravanas ${dias} dias antes do Free</span></li>
        <li><i class="fas fa-percent"></i> <span><strong>Cupons de desconto</strong> exclusivos na viagem</span></li>
        <li><i class="fas fa-gift"></i> <span>Concorra a <strong>brindes</strong> em toda caravana</span></li>
      </ul>
      <div style="display:flex;gap:.6rem;flex-wrap:wrap;">
        <button class="btn btn-gold" data-action="assinar-pro"><i class="fab fa-cc-stripe"></i> Assinar com Stripe</button>
        <button class="btn btn-ghost btn-sm" data-action="sincronizar-pro">Já assinei, verificar</button>
      </div>
    </div>`;

  const box = $('#listaCupons');
  try {
    const { cupons } = await api('/api/cupons');
    box.innerHTML = cupons.length ? cupons.map(c => `
      <div class="cupom" style="${c.usado ? 'opacity:.5' : ''}">
        <div><code>${esc(c.codigo)}</code><div class="muted small">${esc(c.descricao || '')} · válido até ${dataBR(c.validade)}</div></div>
        <div style="text-align:right;"><strong style="font-size:1.4rem;color:var(--gold)">${Number(c.desconto_percentual)}%</strong><div class="small muted">${c.usado ? 'usado' : 'na viagem'}</div></div>
      </div>`).join('')
      : `<div class="empty"><i class="fas fa-ticket-simple"></i>${ehPro() ? 'Nenhum cupom ainda. O administrador envia cupons para assinantes Pro.' : 'Cupons são exclusivos para assinantes Pro.'}</div>`;
  } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }

  const brindesBox = $('#listaBrindes');
  try {
    const brindes = await api('/api/brindes');
    brindesBox.innerHTML = brindes.length ? `<div class="table-wrap"><table>
      <tr><th>Tipo</th><th>Prêmio</th><th>Caravana</th><th>Ganhador</th><th>Data</th></tr>
      ${brindes.map(b => `<tr>
        <td><span class="badge badge-pro">${esc(b.tipo)}</span></td>
        <td><strong>${esc(b.nome)}</strong></td>
        <td>${b.evento_nome ? `${esc(b.evento_nome)} (${esc(b.cidade_saida)})` : '-'}</td>
        <td>${esc(b.ganhador_nome || '-')}</td>
        <td class="small">${dataBR(b.data_sorteio || b.criado_em)}</td>
      </tr>`).join('')}
    </table></div>` : '<div class="empty"><i class="fas fa-gift"></i>Nenhum sorteio realizado ainda.</div>';
  } catch (err) { brindesBox.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

// ─── Organizador ─────────────────────────────────────────────────────────────
async function carregarOrganizador() {
  const box = $('#listaOrganizador');
  box.innerHTML = '<p class="muted">Carregando...</p>';
  try {
    const lista = await api('/api/organizador/caravanas');
    box.innerHTML = lista.length ? lista.map(c => cardCaravana(c, `
      <label class="btn btn-ghost btn-sm" title="Foto da van/ônibus (MinIO)"><i class="fas fa-camera"></i><input type="file" accept="image/*" hidden data-foto-caravana="${c.id}"></label>
      <button class="btn btn-ghost btn-sm" data-action="editar-caravana" data-id="${c.id}" title="Editar"><i class="fas fa-pen"></i></button>
      <button class="btn btn-primary btn-sm" data-action="passageiros" data-id="${c.id}">Passageiros</button>
    `)).join('')
      : '<div class="empty" style="grid-column:1/-1"><i class="fas fa-bus"></i>Você ainda não criou nenhuma caravana.</div>';
  } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

async function verPassageiros(caravanaId) {
  try {
    const lista = await api(`/api/organizador/caravanas/${caravanaId}/passageiros`);
    abrirModal(`
      <h2>Passageiros · caravana #${caravanaId}</h2>
      ${lista.length ? `<div class="table-wrap"><table>
        <tr><th>#</th><th>Passageiro</th><th>Time</th><th>Plano</th><th>Pagamento</th><th>Valor</th></tr>
        ${lista.map(p => `<tr>
          <td>#${p.id}</td><td>${esc(p.nome)}</td><td class="small muted">${esc(p.time_torcida || '-')}</td>
          <td><span class="badge ${p.plano === 'Pro' ? 'badge-pro' : ''}">${p.plano}</span></td>
          <td><span class="badge ${STATUS_PAGAMENTO[p.status_pagamento]?.[1]}">${STATUS_PAGAMENTO[p.status_pagamento]?.[0]}</span></td>
          <td>${brl(p.valor_total)}</td>
        </tr>`).join('')}
      </table></div>` : '<p class="muted">Nenhum passageiro reservado ainda.</p>'}`);
  } catch (err) { toast(err.message, 'err'); }
}

// ─── Admin ───────────────────────────────────────────────────────────────────
function abrirAbaAdmin(tab) {
  $$('#adminTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.atab').forEach(a => a.classList.toggle('hidden', a.id !== tab));
  ({
    'a-caravanas': adminCaravanas, 'a-eventos': adminEventos,
    'a-usuarios': adminUsuarios, 'a-reservas': adminReservas, 'a-logs': adminLogs
  })[tab]();
}
$('#adminTabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) abrirAbaAdmin(t.dataset.tab); });

async function adminCaravanas() {
  const box = $('#a-caravanas');
  box.innerHTML = '<p class="muted">Carregando...</p>';
  try {
    const { caravanas } = await api('/api/caravanas');
    box.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:1rem;">
        <button class="btn btn-primary" data-action="nova-caravana"><i class="fas fa-plus"></i> Nova caravana</button>
      </div>
      <div class="table-wrap"><table>
        <tr><th>#</th><th>Foto (MinIO)</th><th>Evento</th><th>Saída</th><th>Organizador</th><th>Vagas</th><th>Preço</th><th>Status</th><th></th></tr>
        ${caravanas.map(c => `<tr>
          <td>${c.id}</td>
          <td>${c.foto_url ? `<img src="${esc(c.foto_url)}" style="width:76px;height:48px;object-fit:cover;border-radius:8px;" alt="">` : '<span class="muted small">sem foto</span>'}</td>
          <td><span class="badge badge-${esc(c.evento_tipo)}">${MOD[c.evento_tipo]?.nome}</span><br>${esc(c.evento_nome)}</td>
          <td>${esc(c.cidade_saida)}<br><span class="muted small">${dataBR(c.data_saida)}</span><br><span class="muted small">Free: ${dataBR(c.abertura_vendas_em)} · Pro: ${dataBR(c.abertura_pro_em)}</span></td>
          <td class="small">${esc(c.organizador_nome)}</td>
          <td>${c.ocupados}/${c.vagas_totais}</td>
          <td>${brl(c.preco)}</td>
          <td><span class="badge">${esc(c.status)}</span></td>
          <td><div class="actions">
            <label class="btn btn-ghost btn-sm" title="Foto do veículo (MinIO)"><i class="fas fa-camera"></i><input type="file" accept="image/*" hidden data-foto-caravana="${c.id}"></label>
            <button class="btn btn-ghost btn-sm" data-action="detalhe" data-id="${c.id}" title="Ver"><i class="fas fa-eye"></i></button>
            <button class="btn btn-ghost btn-sm" data-action="editar-caravana" data-id="${c.id}" title="Editar"><i class="fas fa-pen"></i></button>
            <button class="btn btn-ghost btn-sm" data-action="passageiros" data-id="${c.id}" title="Passageiros"><i class="fas fa-users"></i></button>
            <button class="btn btn-ghost btn-sm" data-action="sortear-brinde" data-id="${c.id}" title="Sortear brinde"><i class="fas fa-gift"></i></button>
            ${c.status !== 'cancelada' ? `<button class="btn btn-danger btn-sm" data-action="remover-caravana" data-id="${c.id}" title="Cancelar/remover"><i class="fas fa-trash"></i></button>` : ''}
          </div></td>
        </tr>`).join('')}
      </table></div>`;
  } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

async function formCaravana(id) {
  try {
    const eventos = await api('/api/eventos');
    const c = id ? await api(`/api/caravanas/${id}`) : { vagas_totais: 15, status: 'aberta', abertura_vendas_em: '' };
    const opt = (lista, sel, rot) => lista.map(i => `<option value="${i.id}" ${String(i.id) === String(sel) ? 'selected' : ''}>${esc(rot(i))}</option>`).join('');
    abrirModal(`
      <h2>${id ? `Editar caravana #${id}` : 'Nova caravana'}</h2>
      <form id="formCaravana" class="form-grid">
        <div class="field full"><label>Evento</label><select name="evento_id" required>${opt(eventos, c.evento_id, e => `${MOD[e.tipo]?.nome} · ${e.nome} (${dataBR(e.data_evento)}) · ingresso ${brl(e.valor_ingresso)}`)}</select></div>
        <div class="field"><label>Cidade de saída (Alta Paulista)</label><select name="cidade_saida" required>${estado.meta.cidades.map(ci => `<option ${ci === c.cidade_saida ? 'selected' : ''}>${ci}</option>`).join('')}</select></div>
        <div class="field"><label>Local / ponto de embarque</label><input name="local_saida" required value="${esc(c.local_saida || '')}" placeholder="Terminal Rodoviário"></div>
        <div class="field"><label>Data/hora de saída</label><input type="datetime-local" name="data_saida" required value="${paraInput(c.data_saida)}"></div>
        <div class="field"><label>Abertura para o Free (Pro abre ${estado.meta.antecedencia_pro_dias}d antes)</label><input type="datetime-local" name="abertura_vendas_em" required value="${paraInput(c.abertura_vendas_em)}"></div>
        <div class="field"><label>Vagas totais</label><input type="number" name="vagas_totais" min="1" max="60" required value="${c.vagas_totais || 15}"></div>
        <div class="field"><label>Preço da passagem (viagem + ingresso, R$)</label><input type="number" step="0.01" min="1" name="preco" required value="${c.preco ?? ''}"></div>
        <div class="field"><label>Status</label><select name="status">${['aberta', 'lotada', 'cancelada', 'concluida'].map(s => `<option ${s === c.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="full price-breakdown small">
          <strong>Calculadora rápida (combustível + motorista + ingresso a preço de custo)</strong>
          <div class="form-grid" style="margin-top:.5rem;">
            <div class="field"><label>Km (só ida)</label><input type="number" id="calcKm" value="440"></div>
            <div class="field"><label>Consumo (km/l)</label><input type="number" step="0.1" id="calcConsumo" value="9.5"></div>
            <div class="field"><label>Diesel (R$/L)</label><input type="number" step="0.01" id="calcLitro" value="6.29"></div>
            <div class="field"><label>Motorista + pedágios (R$)</label><input type="number" step="0.01" id="calcMot" value="850"></div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="btnCalcularPreco">Calcular preço justo (margem 20%)</button>
        </div>
        <div class="full"><button class="btn btn-primary" type="submit">${id ? 'Salvar alterações' : 'Criar caravana'}</button></div>
      </form>`, true);

    const form = $('#formCaravana');
    $('#btnCalcularPreco').addEventListener('click', () => {
      const ev = eventos.find(x => String(x.id) === form.evento_id.value);
      const vagas = Number(form.vagas_totais.value) || 15;
      const km = Number($('#calcKm').value) || 0;
      const cons = Number($('#calcConsumo').value) || 1;
      const litro = Number($('#calcLitro').value) || 0;
      const mot = Number($('#calcMot').value) || 0;
      const custoViagem = ((2 * km) / cons) * litro + mot;
      const viagemLugar = (custoViagem / vagas) * 1.2;
      const total = Math.round((viagemLugar + Number(ev?.valor_ingresso || 0)) * 100) / 100;
      form.preco.value = total.toFixed(2);
      toast(`Preço sugerido: ${brl(total)} (viagem ${brl(viagemLugar)} + ingresso ${brl(ev?.valor_ingresso || 0)})`);
    });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const body = Object.fromEntries(new FormData(form));
        await api(id ? `/api/caravanas/${id}` : '/api/caravanas', { method: id ? 'PUT' : 'POST', body });
        toast(id ? 'Caravana atualizada.' : 'Caravana criada!');
        fecharModal();
        if (!$('#view-admin').classList.contains('hidden')) adminCaravanas();
        if (!$('#view-organizador').classList.contains('hidden')) carregarOrganizador();
      } catch (err) { toast(err.message, 'err'); }
    });
  } catch (err) { toast(err.message, 'err'); }
}

async function adminEventos() {
  const box = $('#a-eventos');
  try {
    const eventos = await api('/api/eventos');
    box.innerHTML = `
      <div style="display:flex;justify-content:flex-end;gap:.6rem;margin-bottom:1rem;flex-wrap:wrap;">
        <button class="btn btn-ghost" data-action="importar-futebol"><i class="fas fa-futbol"></i> Importar jogo da API Futebol</button>
        <button class="btn btn-primary" data-action="novo-evento"><i class="fas fa-plus"></i> Novo evento</button>
      </div>
      <div class="table-wrap"><table>
        <tr><th>#</th><th>Tipo</th><th>Evento</th><th>Local / País</th><th>Data</th><th>Ingresso</th><th>Origem</th><th></th></tr>
        ${eventos.map(e => `<tr>
          <td>${e.id}</td><td><span class="badge badge-${esc(e.tipo)}">${MOD[e.tipo]?.nome}</span></td>
          <td>${esc(e.nome)}</td>
          <td>${esc(e.local)}<br><span class="muted small">${esc(e.pais)}</span></td>
          <td>${dataBR(e.data_evento)}</td><td>${brl(e.valor_ingresso)}</td>
          <td>${e.api_partida_id ? `<span class="badge badge-futebol">API #${e.api_partida_id}</span>` : '<span class="muted small">manual</span>'}</td>
          <td><div class="actions">
            <button class="btn btn-ghost btn-sm" data-action="editar-evento" data-id="${e.id}"><i class="fas fa-pen"></i></button>
            <button class="btn btn-danger btn-sm" data-action="remover-evento" data-id="${e.id}"><i class="fas fa-trash"></i></button>
          </div></td></tr>`).join('')}
      </table></div>`;
    estado.cache.eventos = eventos;
  } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

function formEvento(id) {
  const e = id ? estado.cache.eventos.find(x => x.id === id) : { tipo: 'futebol', pais: 'Brasil', valor_ingresso: 0 };
  abrirModal(`
    <h2>${id ? `Editar evento #${id}` : 'Novo evento'}</h2>
    <form id="formEvento" class="form-grid">
      <div class="field"><label>Tipo</label><select name="tipo">${Object.entries(MOD).map(([k, v]) => `<option value="${k}" ${k === e.tipo ? 'selected' : ''}>${v.nome}</option>`).join('')}</select></div>
      <div class="field"><label>Nome</label><input name="nome" required value="${esc(e.nome || '')}" placeholder="Palmeiras x Corinthians"></div>
      <div class="field"><label>Local</label><input name="local" required value="${esc(e.local || '')}" placeholder="Allianz Parque - São Paulo"></div>
      <div class="field"><label>País</label><input name="pais" required value="${esc(e.pais || 'Brasil')}"></div>
      <div class="field"><label>Data do evento</label><input type="date" name="data_evento" required value="${String(e.data_evento || '').slice(0, 10)}"></div>
      <div class="field"><label>Valor do ingresso (custo, R$)</label><input type="number" step="0.01" min="0" name="valor_ingresso" value="${e.valor_ingresso || 0}"></div>
      <div class="full"><button class="btn btn-primary" type="submit">Salvar</button></div>
    </form>`);
  $('#formEvento').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api(id ? `/api/eventos/${id}` : '/api/eventos', { method: id ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(ev.target)) });
      toast('Evento salvo.'); fecharModal(); adminEventos();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function importarFutebol() {
  abrirModal(`
    <h2><i class="fas fa-futbol"></i> Importar da API Futebol</h2>
    <div class="form-grid">
      <div class="field"><label>Campeonato</label><select id="impCamp"><option>Carregando...</option></select></div>
      <div class="field"><label>Rodada (vazio = atual)</label><input id="impRodada" type="number" min="1"></div>
      <div class="field"><label>Valor do ingresso (R$)</label><input id="impIngresso" type="number" step="0.01" min="0" value="150"></div>
      <div class="field"><label>Estádio / cidade (fallback)</label><input id="impLocal" value="São Paulo - SP"></div>
    </div>
    <button class="btn btn-ghost btn-sm" id="impBuscar">Buscar partidas</button>
    <div id="impLista" style="margin-top:1rem;"></div>`, true);
  try {
    const camps = await api('/api/futebol/campeonatos');
    $('#impCamp').innerHTML = camps.map(c => `<option value="${c.campeonato_id}">${esc(c.nome)}</option>`).join('');
  } catch (err) { $('#impLista').innerHTML = `<p class="msg err">${esc(err.message)}</p>`; }

  $('#impBuscar').addEventListener('click', async () => {
    const lista = $('#impLista');
    lista.innerHTML = '<p class="muted">Consultando a API Futebol...</p>';
    try {
      const qs = new URLSearchParams({ campeonato: $('#impCamp').value });
      if ($('#impRodada').value) qs.set('rodada', $('#impRodada').value);
      const d = await api(`/api/futebol/partidas?${qs}`);
      lista.innerHTML = `<p class="muted small">${esc(d.nome)}</p><div class="table-wrap"><table>
        ${d.partidas.map(p => `<tr>
          <td><img src="${esc(p.escudo_mandante)}" style="width:28px;display:inline" alt=""> ${esc(p.mandante)} x ${esc(p.visitante)} <img src="${esc(p.escudo_visitante)}" style="width:28px;display:inline" alt=""></td>
          <td>${p.data_iso ? dataBR(p.data_iso.slice(0, 10)) : 'data a definir'}</td>
          <td class="small muted">${esc(p.estadio || '')}</td>
          <td><button class="btn btn-primary btn-sm" data-action="importar-partida" data-id="${p.partida_id}">Importar</button></td>
        </tr>`).join('')}</table></div>`;
    } catch (err) { lista.innerHTML = `<p class="msg err">${esc(err.message)}</p>`; }
  });
}

async function importarPartida(id, botao) {
  botao.disabled = true;
  try {
    const r = await api('/api/futebol/importar', { method: 'POST', body: {
      partida_id: id, valor_ingresso: $('#impIngresso').value, local: $('#impLocal').value
    } });
    toast(`Evento "${r.nome}" importado!`);
    botao.textContent = 'Importado';
    adminEventos();
  } catch (err) { toast(err.message, 'err'); botao.disabled = false; }
}

async function adminUsuarios() {
  const box = $('#a-usuarios');
  try {
    const usuarios = await api('/api/admin/usuarios');
    box.innerHTML = `
      <p class="muted small" style="margin-bottom:1rem;">Novos cadastros entram como <strong>passageiro</strong>. Promova organizadores e administradores aqui. Use <strong>1-Click Pro</strong> para ativar ou desativar o plano Pro instantaneamente.</p>
      <div class="table-wrap"><table>
        <tr><th>#</th><th>Nome</th><th>E-mail</th><th>Time / Torcida</th><th>Plano</th><th>Papel</th><th style="text-align:right;">Ações</th></tr>
        ${usuarios.map(u => `<tr>
          <td>${u.id}</td><td>${esc(u.nome)}</td><td>${esc(u.email)}</td>
          <td class="small muted">${esc(u.time_torcida || '-')}</td>
          <td>${u.premium == 1 ? '<span class="badge badge-pro"><i class="fas fa-crown"></i> Pro</span>' : '<span class="badge">Free</span>'}</td>
          <td><select data-papel="${u.id}" style="width:auto;">${['passageiro', 'organizador', 'admin'].map(p => `<option ${p === (u.papel || u.role) ? 'selected' : ''}>${p}</option>`).join('')}</select></td>
          <td style="text-align:right;white-space:nowrap;">
            ${u.premium == 1
              ? `<button class="btn btn-gold btn-sm" data-action="novo-cupom" data-id="${u.id}" data-nome="${esc(u.nome)}"><i class="fas fa-percent"></i> Cupom</button>
                 <button class="btn btn-ghost btn-sm" data-action="remover-pro" data-id="${u.id}" style="color:#f87171;" title="Desativar Pro"><i class="fas fa-ban"></i> Remover Pro</button>`
              : `<button class="btn btn-primary btn-sm" data-action="promover-pro" data-id="${u.id}"><i class="fas fa-bolt"></i> 1-Click Pro</button>`}
          </td>
        </tr>`).join('')}
      </table></div>`;
  } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

function formCupom(id, nome) {
  abrirModal(`
    <h2>Cupom para ${esc(nome)}</h2>
    <form id="formCupom">
      <div class="field"><label>Desconto na viagem (%)</label><input type="number" name="desconto_percentual" min="1" max="50" value="10" required></div>
      <div class="field"><label>Validade (dias)</label><input type="number" name="dias_validade" min="1" max="365" value="60"></div>
      <div class="field"><label>Descrição</label><input name="descricao" value="Cupom do administrador" maxlength="255"></div>
      <button class="btn btn-gold" type="submit">Gerar cupom</button>
    </form>`);
  $('#formCupom').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const c = await api('/api/admin/cupons', { method: 'POST', body: { usuario_id: id, ...Object.fromEntries(new FormData(ev.target)) } });
      toast(`Cupom ${c.codigo} criado!`); fecharModal();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function adminReservas() {
  const box = $('#a-reservas');
  try {
    const lista = await api('/api/reservas?todas=1');
    box.innerHTML = `<div class="table-wrap"><table>
      <tr><th>#</th><th>Passageiro</th><th>Caravana</th><th>Total</th><th>Status</th><th>Criada</th></tr>
      ${lista.map(r => `<tr>
        <td>${r.id}</td><td>${esc(r.passageiro_nome)}<br><span class="muted small">${esc(r.passageiro_email)}</span></td>
        <td>#${r.caravana_id} ${esc(r.evento_nome)}<br><span class="muted small">${esc(r.cidade_saida)} · ${dataBR(r.data_saida)}</span></td>
        <td>${brl(r.valor_total || r.caravana_preco)}${Number(r.desconto) ? `<br><span class="muted small">-${brl(r.desconto)} cupom</span>` : ''}</td>
        <td><span class="badge ${STATUS_PAGAMENTO[r.status_pagamento]?.[1]}">${STATUS_PAGAMENTO[r.status_pagamento]?.[0]}</span></td>
        <td class="small">${dataBR(r.criado_em)}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">Nenhuma reserva.</td></tr>'}
    </table></div>`;
  } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

async function adminLogs() {
  const box = $('#a-logs');
  try {
    const logs = await api('/api/logs?limit=200');
    box.innerHTML = `<p class="muted small" style="margin-bottom:1rem;">Eventos de negócio e segurança gravados no Redis Streams pelo log-service.</p>
      <div class="table-wrap"><table>
      <tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Detalhes</th><th>IP</th><th></th></tr>
      ${logs.map(l => `<tr>
        <td class="small">${new Date(l.data_hora || l.criado_em).toLocaleString('pt-BR')}</td><td>${esc(l.usuario_id)}</td>
        <td><span class="badge ${/negada|403|falha|alheia/.test(l.acao) ? 'badge-bad' : /reserv|caravana|cupom|pagamento|brinde/.test(l.acao) ? 'badge-ok' : ''}">${esc(l.acao)}</span></td>
        <td class="small">${esc(l.detalhes)}</td><td class="small muted">${esc(l.ip)}</td>
        <td><button class="btn btn-ghost btn-sm" data-action="apagar-log" data-id="${esc(l.id_redis || l.id)}"><i class="fas fa-trash"></i></button></td>
      </tr>`).join('')}
    </table></div>`;
  } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

// ─── Ações globais (data-action) ─────────────────────────────────────────────
const acoes = {
  'fechar-modal': fecharModal,
  'editar-time': () => abrirModalMeuTime(),
  'detalhe': (id) => detalheCaravana(id),
  'comprar': (id, el) => comprar(id, el),
  'pagar': (id) => pagarPendente(id),
  'cancelar-reserva': (id, el) => cancelarReserva(id, el.dataset.status),
  'passageiros': (id) => verPassageiros(id),
  'assinar-pro': async () => {
    try { const r = await api('/api/stripe/checkout', { method: 'POST' }); window.location.href = r.url; }
    catch (err) { toast(err.message, 'err'); }
  },
  'sincronizar-pro': async () => {
    try { const r = await api('/api/stripe/sincronizar', { method: 'POST' }); toast(r.message, r.premium ? 'ok' : 'err'); await carregarMe(); carregarPro(); }
    catch (err) { toast(err.message, 'err'); }
  },
  'cancelar-pro': async () => {
    if (!confirm('Cancelar a assinatura Pro?')) return;
    try { const r = await api('/api/stripe/cancelar', { method: 'POST' }); toast(r.message); await carregarMe(); carregarPro(); }
    catch (err) { toast(err.message, 'err'); }
  },
  'nova-caravana': () => formCaravana(null),
  'editar-caravana': (id) => formCaravana(id),
  'remover-caravana': async (id) => {
    if (!confirm('Cancelar/remover esta caravana? Quem já pagou recebe estorno automático.')) return;
    try { const r = await api(`/api/caravanas/${id}`, { method: 'DELETE' }); toast(r.message); adminCaravanas(); }
    catch (err) { toast(err.message, 'err'); }
  },
  'sortear-brinde': async (id) => {
    const nome = prompt('Qual brinde será sorteado entre os passageiros pagos?', 'Camisa oficial');
    if (!nome) return;
    try { const r = await api('/api/admin/brindes/sortear', { method: 'POST', body: { caravana_id: id, nome } }); toast(`🎁 ${r.ganhador} ganhou: ${r.nome}`); }
    catch (err) { toast(err.message, 'err'); }
  },
  'novo-evento': () => formEvento(null),
  'editar-evento': (id) => formEvento(id),
  'remover-evento': async (id) => {
    if (!confirm('Remover este evento?')) return;
    try { await api(`/api/eventos/${id}`, { method: 'DELETE' }); toast('Evento removido.'); adminEventos(); }
    catch (err) { toast(err.message, 'err'); }
  },
  'importar-futebol': importarFutebol,
  'importar-partida': (id, el) => importarPartida(id, el),
  'novo-cupom': (id, el) => formCupom(id, el.dataset.nome),
  'apagar-log': async (_, el) => {
    try { await api(`/api/logs/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' }); adminLogs(); }
    catch (err) { toast(err.message, 'err'); }
  },
  'promover-pro': async (id) => {
    try {
      await api(`/api/admin/usuarios/${id}/promover-pro`, { method: 'POST' });
      toast(`Usuário #${id} promovido a Pro com 1-Click!`);
      adminUsuarios();
    } catch (err) { toast(err.message, 'err'); }
  },
  'remover-pro': async (id) => {
    try {
      await api(`/api/admin/usuarios/${id}/remover-pro`, { method: 'POST' });
      toast(`Plano Pro desativado para o usuário #${id}.`);
      adminUsuarios();
    } catch (err) { toast(err.message, 'err'); }
  }
};

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-view]');
  if (nav) { e.preventDefault(); fecharModal(); irPara(nav.dataset.view); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = acoes[el.dataset.action];
  if (fn) fn(el.dataset.id && /^\d+$/.test(el.dataset.id) ? Number(el.dataset.id) : el.dataset.id, el);
});

document.addEventListener('change', async (e) => {
  const papel = e.target.closest('[data-papel]');
  if (papel) {
    try { await api(`/api/admin/usuarios/${papel.dataset.papel}/papel`, { method: 'PUT', body: { role: papel.value } }); toast('Papel atualizado.'); }
    catch (err) { toast(err.message, 'err'); adminUsuarios(); }
    return;
  }
  const foto = e.target.closest('[data-foto-caravana]');
  if (foto && foto.files[0]) {
    const fd = new FormData();
    fd.append('foto', foto.files[0]);
    try {
      await api(`/api/caravanas/${foto.dataset.fotoCaravana}/foto`, { method: 'POST', body: fd });
      toast('Foto da caravana salva no MinIO!');
      if (!$('#view-admin').classList.contains('hidden')) adminCaravanas();
      if (!$('#view-organizador').classList.contains('hidden')) carregarOrganizador();
    } catch (err) { toast(err.message, 'err'); }
  }
});

// ─── Retorno do Stripe ───────────────────────────────────────────────────────
async function tratarRetornoStripe() {
  const qs = new URLSearchParams(location.search);
  const limpar = () => history.replaceState({}, '', 'app.html');
  if (qs.get('pagamento') === 'sucesso' && qs.get('session_id')) {
    limpar();
    try {
      const r = await api(`/api/reservas/pagamento/confirmar?session_id=${encodeURIComponent(qs.get('session_id'))}`);
      toast(`✅ ${r.message} Reserva #${r.reserva_id}.`);
    } catch (err) { toast(err.message, 'err'); }
    return 'passagens';
  }
  if (qs.get('pagamento') === 'cancelado') {
    limpar();
    toast('Pagamento não concluído. Sua vaga fica reservada por alguns minutos em "Minhas passagens".', 'err');
    return 'passagens';
  }
  if (qs.get('pro') === 'sucesso' && qs.get('session_id')) {
    limpar();
    try { await api(`/api/stripe/verify-session?session_id=${encodeURIComponent(qs.get('session_id'))}`); toast('👑 Bem-vindo ao Pro!'); }
    catch (err) { toast(err.message, 'err'); }
    return 'pro';
  }
  if (qs.get('pro') === 'cancelado') { limpar(); return 'pro'; }
  return null;
}

// ─── Início ──────────────────────────────────────────────────────────────────
(async function iniciar() {
  try {
    const destino = await tratarRetornoStripe();
    await carregarMe();
    estado.meta = await api('/api/meta');
    $('#filtroCidade').insertAdjacentHTML('beforeend', estado.meta.cidades.map(c => `<option>${esc(c)}</option>`).join(''));
    const papel = estado.me.papel || estado.me.role;
    irPara(destino || (papel === 'organizador' ? 'organizador' : 'caravanas'));
  } catch (err) {
    console.error(err);
  }
})();
