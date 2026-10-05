require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { DatabaseSync } = require('node:sqlite'); // ponytail: sqlite embutido do Node 22, sem dependência nova

const db = new DatabaseSync('bots.db');
// WAL: leitura não trava escrita, e o banco sobrevive a queda do processo no meio de um write.
// busy_timeout: espera o lock em vez de estourar SQLITE_BUSY se outro processo abrir o mesmo arquivo.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  start_message TEXT
);
-- ponytail: plano inteiro em 1 coluna JSON; normalize se precisar consultar por campo
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  name TEXT NOT NULL,
  price REAL NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_bumps (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  name TEXT NOT NULL,
  price REAL NOT NULL,
  data TEXT NOT NULL
);
-- Fila do downsell. bot_id é o que decide quem envia: em chat privado o chat_id
-- é igual para todos os bots, então sem ele um bot mandaria a mensagem do outro.
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  chat_id TEXT NOT NULL,
  msg_index INTEGER NOT NULL,
  send_at INTEGER NOT NULL,
  sent_at INTEGER,
  canceled INTEGER NOT NULL DEFAULT 0,
  UNIQUE (bot_id, chat_id, msg_index)
);
-- Cobrança PIX gerada no gateway. Guarda o que entregar quando o pagamento cair.
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  chat_id TEXT NOT NULL,
  plan_id INTEGER NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  chat_id TEXT NOT NULL,
  plan_id INTEGER NOT NULL,
  total REAL NOT NULL,
  created_at INTEGER NOT NULL
);`);

// ponytail: migração pobre — coluna nova em banco já criado. Vira ferramenta de migration se virarem várias.
try { db.exec('ALTER TABLE bots ADD COLUMN downsell TEXT'); } catch { /* já existe */ }
try { db.exec('ALTER TABLE bots ADD COLUMN start_image TEXT'); } catch { /* já existe */ }
try { db.exec('ALTER TABLE bots ADD COLUMN gateway_token TEXT'); } catch { /* já existe */ }
try { db.exec('ALTER TABLE bots ADD COLUMN gateway_document TEXT'); } catch { /* já existe */ }
try { db.exec('ALTER TABLE bots ADD COLUMN cnpj TEXT'); } catch { /* já existe */ }

const listPlans = (botId) =>
  db.prepare('SELECT id, data FROM plans WHERE bot_id = ?').all(botId)
    .map(({ id, data }) => ({ id, ...JSON.parse(data) }));

// Ordem = ordem de cadastro (id), é a ordem em que são oferecidos
const listBumps = (botId) =>
  db.prepare('SELECT id, data FROM order_bumps WHERE bot_id = ? ORDER BY id').all(botId)
    .map(({ id, data }) => ({ id, ...JSON.parse(data) }));

const bots = [];

const money = (v) => `R$ ${v.toFixed(2).replace('.', ',')}`;

// Boas-vindas do /start: só o texto configurado. Os planos vêm depois, no "Acessar agora".
const boasVindasText = (config) => config.start_message || `Olá! Eu sou o bot ${config.name}.`;

const acessarKeyboard = Markup.inlineKeyboard([[Markup.button.callback('🚀 Acessar agora', 'menu')]]);

// Lista de planos do banco (lidos na hora, plano novo já aparece)
function menuText(plans) {
  const lista = plans.length
    ? plans.map((p) => `• ${p.name} — ${money(p.price)}${p.duration ? ` (${p.duration})` : ''}`).join('\n')
    : 'Nenhum plano disponível no momento.';
  return `📦 Planos disponíveis:\n${lista}`;
}

// Preço com desconto do downsell (pct 0-100), arredondado em centavos
const comDesconto = (price, pct) => Math.round(price * (100 - (pct || 0))) / 100;

// Um botão por plano, um por linha. pct > 0 = botões do downsell com desconto.
const menuKeyboard = (plans, pct = 0) =>
  Markup.inlineKeyboard(
    plans.map((p) => [Markup.button.callback(
      `${p.name} — ${money(comDesconto(p.price, pct))}${pct ? ` (-${pct}%)` : ''}`,
      `plan:${p.id}:${pct}`,
    )])
  );

// Imagem ou vídeo opcional acima das boas-vindas. Caption do Telegram vai só até 1024
// chars (vale para foto e vídeo): passou disso, a mídia vai sozinha e o texto/botões
// logo em seguida.
const menuMode = (startImage, texto) =>
  !startImage ? 'text' : texto.length <= 1024 ? 'photo_caption' : 'photo_then_text';

// start_image aceita vídeo: quem manda é a extensão da URL, o resto vai como foto.
// Query string/hash depois da extensão não atrapalha (.../v.mp4?token=1).
const ehVideo = (url) => /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(url);

// Um envio só para os dois casos — o método muda, o resto das opções é igual.
// Versão por chat_id: a fila do downsell não tem ctx, só a instância do bot.
const enviarMidiaChat = (telegram, chatId, url, extra) =>
  ehVideo(url) ? telegram.sendVideo(chatId, url, extra) : telegram.sendPhoto(chatId, url, extra);

const enviarMidia = (ctx, url, extra) => enviarMidiaChat(ctx.telegram, ctx.chat.id, url, extra);

// Oferta de um order bump: Adicionar / Recusar
// ponytail: estado (plano + aceitos) vai no callback_data como bitmask — sem sessão em memória.
// Teto: 31 bumps por bot; se passar disso, guarde o carrinho numa tabela.
const bumpPrompt = (bump, planId, pct, idx, mask) => [
  `➕ ${bump.name} — ${money(bump.price)}${bump.description ? `\n${bump.description}` : ''}`,
  Markup.inlineKeyboard([[
    Markup.button.callback('✅ Adicionar', `bump:${planId}:${pct}:${idx}:${mask}:1`),
    Markup.button.callback('❌ Recusar', `bump:${planId}:${pct}:${idx}:${mask}:0`),
  ]]),
];

// Link de convite de cada grupo VIP do plano — gerado pela API a partir do idGroup.
// ponytail: 1 uso e 1h de validade; o bot precisa ser admin do grupo.
const criarLink = (telegram, id) =>
  telegram.createChatInviteLink(id, {
    member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + 3600,
  });

async function vipLinks(telegram, grupos = []) {
  const linhas = [];
  for (const g of grupos) {
    const id = g?.idGroup;
    if (!id) continue;
    try {
      let link;
      try {
        link = await criarLink(telegram, id);
      } catch (err) {
        // Grupo virado supergrupo: o Telegram devolve o id novo no erro
        const novoId = err.response?.parameters?.migrate_to_chat_id ?? err.parameters?.migrate_to_chat_id;
        if (!novoId) throw err;
        console.log(`Grupo ${id} virou supergrupo: atualize o cadastro para idGroup ${novoId}`);
        link = await criarLink(telegram, novoId);
      }
      linhas.push(`• ${g.name || id}: ${link.invite_link}`);
    } catch (err) {
      linhas.push(`• ${g.name || id}: ❌ não foi possível gerar o link (${err.message})`);
    }
  }
  return linhas;
}

// ─── Gateway PIX ─────────────────────────────────────────────────────────────
// Status que contam como pago (o gateway devolve waiting_payment até cair)
const PAGO = ['paid', 'approved'];

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://api.bluevisionsolucoes.com.br/functions/v1';

const centavos = (v) => Math.round(v * 100);

async function gatewayFetch(token, caminho, init) {
  const r = await fetch(`${GATEWAY_URL}${caminho}`, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: token },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.success === false) throw new Error(body.error || body.message || `gateway respondeu ${r.status}`);
  return body;
}

// CPF com dígitos verificadores válidos, para quando o bot não tem gateway_document.
// ponytail: é documento fictício — não é o do comprador. Gateway com KYC pode recusar ou marcar;
// se precisar do CPF real, peça no fluxo antes de gerar a cobrança.
function cpfAleatorio() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (new Set(n).size === 1) return cpfAleatorio(); // 111.111.111-11 e cia são recusados por validador
  const dv = (base) => {
    const soma = base.reduce((t, d, i) => t + d * (base.length + 1 - i), 0);
    return (soma * 10) % 11 % 10;
  };
  n.push(dv(n));
  n.push(dv(n));
  return n.join('');
}

// Consulta de status: GET /transaction-status/<id>, resposta em { success, data: { status } }
async function consultarStatus(token, id) {
  const r = await gatewayFetch(token, `/transaction-status/${id}`);
  const status = r.data?.status;
  if (!status) throw new Error('gateway não devolveu o status');
  return status;
}

// Depois de gerar o PIX o bot fica conferindo sozinho por 1 minuto; passou disso, quem manda
// é o botão "Verificar pagamento", que continua na tela.
// ponytail: polling curto no processo. Confirmação a qualquer hora pede o postbackUrl do gateway.
const AUTO_INTERVALO = Number(process.env.AUTO_CHECK_MS) || 5000;
const AUTO_LIMITE = Number(process.env.AUTO_CHECK_TOTAL_MS) || 60_000;

const sleep = (ms) => new Promise((ok) => { setTimeout(ok, ms).unref?.(); });

// Consulta até pagar ou estourar o tempo. Devolve o status pago, ou null.
async function esperarPago(token, txId, limiteMs = AUTO_LIMITE, intervaloMs = AUTO_INTERVALO) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    await sleep(intervaloMs);
    const status = await consultarStatus(token, txId).catch(() => null); // gateway fora do ar: tenta de novo
    if (PAGO.includes(status)) return status;
  }
  return null;
}

// Corpo da cobrança. Documento: o do cadastro do bot, ou um CPF gerado se não houver.
const pixPayload = (config, from, itens, total) => ({
  customer: {
    document: { number: config.gateway_document || cpfAleatorio() },
    name: [from.first_name, from.last_name].filter(Boolean).join(' ') || `telegram ${from.id}`,
    email: `${from.id}@telegram.bot`,
    phone: '11999999999',
  },
  paymentMethod: 'PIX',
  items: itens.map((i) => ({ title: i.name, unitPrice: centavos(i.price), quantity: 1 })),
  amount: centavos(total),
  installments: 1,
});

// ponytail: QR renderizado por serviço externo — zero dependência, e o copia e cola do texto
// paga do mesmo jeito se ele cair. Upgrade: `npm i qrcode` e gerar o PNG aqui.
const qrUrl = (payload) =>
  `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(payload)}`;

const escapeHtml = (t) => String(t).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Formato pedido: "R$9,90" (sem espaço), diferente do money() usado nas listagens
const valorPix = (v) => `R$${v.toFixed(2).replace('.', ',')}`;

const pixMessage = (planName, total, copiaECola) => [
  `🌟 Você selecionou o seguinte plano:`,
  ``,
  `🎁 Plano: ${escapeHtml(planName)}`,
  `💰 Valor: ${valorPix(total)}`,
  ``,
  `💠 Pague via Pix Copia e Cola (ou QR Code em alguns bancos):`,
  ``,
  `<code>${escapeHtml(copiaECola)}</code>`,
  ``,
  `👆 Toque na chave PIX acima para copiá-la`,
  ``,
  `‼️ Após o pagamento, clique no botão abaixo para verificar o status:`,
].join('\n');

// ponytail: desconto do downsell vale só para o plano; bump entra pelo preço cheio
function summaryText(plan, chosen, pct = 0) {
  const preco = comDesconto(plan.price, pct);
  const total = Math.round((preco + chosen.reduce((s, b) => s + b.price, 0)) * 100) / 100;
  const linhas = [
    `• ${plan.name} — ${money(preco)}${pct ? ` (de ${money(plan.price)}, -${pct}%)` : ''}`,
    ...chosen.map((b) => `• ${b.name} — ${money(b.price)}`),
  ];
  return { texto: `🧾 Resumo do pedido\n${linhas.join('\n')}\n\n💰 Total: ${money(total)}`, total };
}

const agora = () => Math.floor(Date.now() / 1000);

const jaComprou = (botId, chatId) =>
  !!db.prepare('SELECT 1 FROM purchases WHERE bot_id = ? AND chat_id = ?').get(botId, String(chatId));

// Gatilhos implementados. Quem não manda o campo cai no 'start'.
const GATILHOS = ['start', 'abandoned_checkout'];

// Enfileira as mensagens do downsell para esse chat, cada uma no seu delay.
// `gatilho` é o evento que acabou de acontecer: só agenda se bater com o do bot.
// No 'start', UNIQUE(bot_id, chat_id, msg_index) faz /start repetido não duplicar.
// No 'abandoned_checkout' a fila do chat é zerada antes: cada PIX não pago recomeça a
// contagem, senão a linha do abandono anterior barraria o novo pelo mesmo UNIQUE.
function agendarDownsell(config, chatId, gatilho = 'start') {
  const ds = config.downsell;
  if (!ds?.enabled || !Array.isArray(ds.messages) || !ds.messages.length) return 0;
  if ((ds.trigger || 'start') !== gatilho) return 0;
  if (ds.audience === 'new' && jaComprou(config.id, chatId)) return 0;

  if (gatilho === 'abandoned_checkout') {
    db.prepare('DELETE FROM scheduled_messages WHERE bot_id = ? AND chat_id = ?')
      .run(config.id, String(chatId));
  }

  const ins = db.prepare(
    'INSERT OR IGNORE INTO scheduled_messages (bot_id, chat_id, msg_index, send_at) VALUES (?, ?, ?, ?)'
  );
  const t = agora();
  let n = 0;
  ds.messages.forEach((m, i) => { n += ins.run(config.id, String(chatId), i, t + Math.round(m.delay_minutes * 60)).changes; });
  return n;
}

const cancelarDownsell = (botId, chatId) =>
  db.prepare('UPDATE scheduled_messages SET canceled = 1 WHERE bot_id = ? AND chat_id = ? AND sent_at IS NULL')
    .run(botId, String(chatId)).changes;

function registrarCompra(botId, chatId, planId, total) {
  db.prepare('INSERT INTO purchases (bot_id, chat_id, plan_id, total, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(botId, String(chatId), planId, total, agora());
  cancelarDownsell(botId, chatId); // comprou: não recebe mais oferta de desconto
}

// Varre a fila e envia o que venceu. SEMPRE pelo bot dono da linha (bot_id):
// em chat privado o chat_id é o mesmo para todos os bots, então resolver por
// chat mandaria a mensagem de um bot pela conta de outro.
// ponytail: varredura de 1 min, suficiente para delay em minutos; vira fila de verdade se precisar de segundos.
async function enviarPendentes() {
  const pendentes = db.prepare(
    'SELECT * FROM scheduled_messages WHERE sent_at IS NULL AND canceled = 0 AND send_at <= ? ORDER BY send_at'
  ).all(agora());

  for (const row of pendentes) {
    const dono = bots.find((b) => b.id === row.bot_id);
    if (!dono) continue; // bot não está no ar: fica na fila, não vaza para outro bot

    const ds = dono.downsell;
    const msg = ds?.messages?.[row.msg_index];
    if (!ds?.enabled || !msg) {
      db.prepare('UPDATE scheduled_messages SET canceled = 1 WHERE id = ?').run(row.id);
      continue;
    }
    if (ds.audience === 'new' && jaComprou(dono.id, row.chat_id)) {
      db.prepare('UPDATE scheduled_messages SET canceled = 1 WHERE id = ?').run(row.id);
      continue;
    }

    const pct = msg.discount_percent || 0;
    const extra = ds.button_mode === 'plans_discount' ? menuKeyboard(listPlans(dono.id), pct) : undefined;
    try {
      // msg.image é opcional e aceita foto ou vídeo, igual ao start_image.
      let naLegenda = menuMode(msg.image, msg.text) === 'photo_caption';
      if (msg.image) {
        try {
          await enviarMidiaChat(dono.instance.telegram, row.chat_id, msg.image,
            naLegenda ? { caption: msg.text, ...extra } : undefined);
        } catch (err) {
          // URL quebrada não engole a oferta: cai para texto puro, igual ao /start
          console.error(`[${dono.name}] mídia do downsell falhou: ${err.message}`);
          naLegenda = false;
        }
      }
      if (!naLegenda) await dono.instance.telegram.sendMessage(row.chat_id, msg.text, extra);
      db.prepare('UPDATE scheduled_messages SET sent_at = ? WHERE id = ?').run(agora(), row.id);
      console.log(`[${dono.name}] downsell #${row.msg_index} enviado para ${row.chat_id}`);
    } catch (err) {
      // bloqueou o bot, chat apagado etc: cancela em vez de tentar para sempre
      db.prepare('UPDATE scheduled_messages SET canceled = 1 WHERE id = ?').run(row.id);
      console.error(`[${dono.name}] downsell falhou para ${row.chat_id}: ${err.message}`);
    }
  }
  return pendentes.length;
}

function startBot(row) {
  // `config` é a config viva do bot: sincronizarBots e POST /bots dão Object.assign nela,
  // e como os handlers leem daqui, a mudança vale no próximo /start — sem restart.
  const config = { ...row };
  const bot = new Telegraf(config.token);

  // Passo 1: boas-vindas (+ imagem) com o botão "Acessar agora"
  const enviarMenu = async (ctx) => {
    const texto = boasVindasText(config);
    const teclado = acessarKeyboard;
    const modo = menuMode(config.start_image, texto);
    if (modo !== 'text') {
      try {
        if (modo === 'photo_caption') return await enviarMidia(ctx, config.start_image, { caption: texto, ...teclado });
        await enviarMidia(ctx, config.start_image);
      } catch (err) {
        console.error(`[${config.name}] start_image falhou: ${err.message}`); // URL quebrada não engole o menu
      }
    }
    return ctx.reply(texto, teclado);
  };

  // Bumps do plano (só se o plano tiver order_bump.enabled)
  const bumpsFor = (plan) => (plan.order_bump?.enabled ? listBumps(config.id) : []);

  // Oferece o bump idx; se não houver mais, fecha com o resumo + links dos grupos VIP
  const nextStep = async (ctx, plan, pct, idx, mask) => {
    const bumps = bumpsFor(plan);
    if (idx < bumps.length) return ctx.reply(...bumpPrompt(bumps[idx], plan.id, pct, idx, mask));

    const escolhidos = bumps.filter((_, i) => mask & (1 << i));
    const { texto, total } = summaryText(plan, escolhidos, pct);
    await ctx.reply(texto);

    // Sem gateway cadastrado o bot entrega na hora (é como os bots antigos funcionavam)
    if (!config.gateway_token) {
      registrarCompra(config.id, ctx.chat.id, plan.id, total);
      return entregarAcesso(ctx, plan);
    }
    return gerarPix(ctx, plan, escolhidos, comDesconto(plan.price, pct), total);
  };

  // Confirma o pagamento uma vez só: registra a compra e entrega o acesso.
  // `reentregar` é o clique manual numa cobrança já confirmada — reenvia os links sem duplicar a compra.
  const confirmar = async (ctx, txId, status, reentregar = false) => {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ? AND bot_id = ?').get(txId, config.id);
    if (!tx) return;
    const jaPago = PAGO.includes(tx.status);
    db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run(status, txId);
    if (jaPago && !reentregar) return; // a checagem automática não repete o que o botão já entregou
    if (!jaPago) registrarCompra(config.id, tx.chat_id, tx.plan_id, tx.total);

    await ctx.reply('✅ Pagamento confirmado!');
    const plan = listPlans(config.id).find((p) => p.id === tx.plan_id);
    return plan ? entregarAcesso(ctx, plan) : ctx.reply('O plano saiu do ar — fale com o suporte.');
  };

  const entregarAcesso = async (ctx, plan) => {
    const links = await vipLinks(bot.telegram, plan.vip_groups);
    if (links.length) await ctx.reply(`🔗 Seus grupos VIP:\n${links.join('\n')}`);
  };

  // Cria a cobrança no gateway e manda QR + copia e cola. Só entrega o acesso depois de pago.
  const gerarPix = async (ctx, plan, bumpsEscolhidos, precoPlano, total) => {
    const itens = [{ name: plan.name, price: precoPlano }, ...bumpsEscolhidos];
    let tx;
    try {
      tx = await gatewayFetch(config.gateway_token, '/transactions', {
        method: 'POST',
        body: JSON.stringify(pixPayload(config, ctx.from, itens, total)),
      });
    } catch (err) {
      console.error(`[${config.name}] gerar pix falhou: ${err.message}`);
      return ctx.reply('❌ Não consegui gerar o PIX agora. Tente de novo em instantes.');
    }

    const copiaECola = tx.pix?.qrcode;
    if (!copiaECola) return ctx.reply('❌ O gateway não devolveu o código PIX. Tente de novo.');

    db.prepare(`INSERT OR REPLACE INTO transactions (id, bot_id, chat_id, plan_id, total, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(tx.id, config.id, String(ctx.chat.id), plan.id, total, tx.status || 'waiting_payment', agora());

    const legenda = pixMessage(plan.name, total, copiaECola);
    const opcoes = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ Verificar pagamento', `pix:${tx.id}`)]]),
    };
    const qr = qrUrl(copiaECola);
    let naLegenda = menuMode(qr, legenda) === 'photo_caption';
    try {
      await (naLegenda ? ctx.replyWithPhoto(qr, { caption: legenda, ...opcoes }) : ctx.replyWithPhoto(qr));
    } catch (err) {
      console.error(`[${config.name}] QR falhou: ${err.message}`); // sem imagem, o copia e cola paga igual
      naLegenda = false;
    }
    if (!naLegenda) await ctx.reply(legenda, opcoes);

    // Cobrança na mão e ainda não paga = checkout aberto. Se o pagamento cair,
    // registrarCompra cancela a fila; se não cair, o downsell sai no delay configurado.
    if (ctx.chat.type === 'private') agendarDownsell(config, ctx.chat.id, 'abandoned_checkout');

    // Confere sozinho por 1 min; se cair nesse tempo o comprador nem precisa clicar
    esperarPago(config.gateway_token, tx.id)
      .then((status) => status && confirmar(ctx, tx.id, status))
      .catch((err) => console.error(`[${config.name}] auto-check falhou: ${err.message}`));
  };

  // Passo 2: os planos, com um botão por plano
  const enviarPlanos = (ctx) => {
    const plans = listPlans(config.id);
    return ctx.reply(menuText(plans), menuKeyboard(plans));
  };

  bot.start(async (ctx) => {
    await enviarMenu(ctx);
    if (ctx.chat.type === 'private') agendarDownsell(config, ctx.chat.id); // só faz sentido no privado
  });
  bot.command('planos', enviarPlanos);
  bot.action('menu', async (ctx) => {
    await ctx.answerCbQuery();
    return enviarPlanos(ctx);
  });

  bot.action(/^plan:(\d+)(?::(\d+))?$/, async (ctx) => {
    const plan = listPlans(config.id).find((p) => p.id === Number(ctx.match[1]));
    const pct = Number(ctx.match[2] || 0);
    await ctx.answerCbQuery();
    if (!plan) return ctx.reply('Plano não encontrado.');
    const preco = comDesconto(plan.price, pct);
    await ctx.reply(`✅ Você selecionou: ${plan.name}\nValor: ${money(preco)}${pct ? ` (-${pct}%)` : ''}${plan.duration ? `\nDuração: ${plan.duration}` : ''}`);
    return nextStep(ctx, plan, pct, 0, 0);
  });

  bot.action(/^bump:(\d+):(\d+):(\d+):(\d+):(0|1)$/, async (ctx) => {
    const [, planId, pctRaw, idxRaw, maskRaw, aceitou] = ctx.match;
    const plan = listPlans(config.id).find((p) => p.id === Number(planId));
    await ctx.answerCbQuery();
    if (!plan) return ctx.reply('Plano não encontrado.');

    const idx = Number(idxRaw);
    const mask = aceitou === '1' ? Number(maskRaw) | (1 << idx) : Number(maskRaw);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {}); // tira os botões da oferta respondida
    return nextStep(ctx, plan, Number(pctRaw), idx + 1, mask);
  });

  // Botão "Verificar pagamento": consulta o gateway e, se pago, libera o acesso
  bot.action(/^pix:([\w-]+)$/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCbQuery('Consultando...');
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ? AND bot_id = ?').get(id, config.id);
    if (!tx) return ctx.reply('Cobrança não encontrada.');

    let status;
    try {
      status = await consultarStatus(config.gateway_token, id);
    } catch (err) {
      console.error(`[${config.name}] consulta pix falhou: ${err.message}`);
      return ctx.reply('❌ Não consegui consultar agora. Tente de novo em instantes.');
    }

    if (!PAGO.includes(status)) {
      db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run(status, id);
      return ctx.reply('⏳ Pagamento ainda não identificado. Assim que cair, clique no botão de novo.');
    }
    return confirmar(ctx, id, status, true);
  });

  // ID do grupo VIP para colar no painel (passo "Grupo VIP" do wizard)
  const idDoGrupo = (chatId) => ({
    text: `🆔 ID deste grupo: <code>${chatId}</code>\n\nCopie e cole no painel, no passo "Grupo VIP".`,
    extra: { parse_mode: 'HTML' },
  });

  bot.command('groupid', async (ctx) => {
    if (ctx.chat.type === 'private') {
      return ctx.reply('Envie /groupid dentro do grupo privado (com o bot já adicionado como administrador).');
    }
    const { text, extra } = idDoGrupo(ctx.chat.id);
    await ctx.reply(text, extra);
  });

  // Virou admin num grupo/canal: já manda o ID lá, sem precisar do /groupid.
  // Canal não entrega comando como `message`, então este é o único caminho para canais.
  bot.on('my_chat_member', async (ctx) => {
    const { chat, old_chat_member: antes, new_chat_member: agora } = ctx.myChatMember;
    if (chat.type === 'private' || agora.status !== 'administrator' || antes.status === 'administrator') return;
    const { text, extra } = idDoGrupo(chat.id);
    await ctx.telegram.sendMessage(chat.id, text, extra).catch((err) =>
      console.error(`[${config.name}] não consegui mandar o ID no grupo ${chat.id}: ${err.message}`));
  });

  bot.command('info', async (ctx) => {
    await ctx.reply(`Eu sou o bot ${config.name}`);
  });

  bot.on('message', (ctx) => {
    console.log(`[${config.name}] mensagem recebida`);
    console.log('Chat:', ctx.chat.id);
    console.log('User:', ctx.from.id);
  });

  // Erro dentro de um handler não pode derrubar o polling
  bot.catch((err, ctx) => console.error(`[${config.name}] erro no update ${ctx?.updateType}:`, err.message));

  config.instance = bot;
  bots.push(config);
  manterVivo(config);
  return config;
}

// Religa o bot que caiu, com backoff (5s, 10s, 20s... até 5 min).
// launch() só termina quando o polling para — por erro fatal ou por bot.stop().
const RETRY_BASE = Number(process.env.RETRY_BASE_MS) || 5000;
const RETRY_MAX = 5 * 60_000;

function manterVivo(entry, tentativa = 1) {
  if (entry.parando) return;
  const inicio = Date.now();
  entry.rodando = true;

  const religar = (motivo) => {
    entry.rodando = false;
    if (entry.parando) return;
    // ficou de pé mais de 1 min? o problema passou, volta a contar do começo
    const falhas = Date.now() - inicio > 60_000 ? 1 : tentativa;
    const espera = Math.min(RETRY_BASE * 2 ** (falhas - 1), RETRY_MAX);
    console.error(`[${entry.name}] caiu (${motivo}); religando em ${Math.round(espera / 1000)}s`);
    setTimeout(() => manterVivo(entry, falhas + 1), espera).unref?.();
  };

  entry.instance.launch()
    .then(() => religar('polling encerrado'))
    .catch((err) => religar(err.message));
}

// Espelha a tabela `bots` no que está rodando. Roda no boot e a cada tick, então
// alteração feita por fora (outro processo, direto no banco) entra sozinha:
// bot novo sobe, e config de bot já no ar é atualizada — nada disso pede restart.
function sincronizarBots() {
  const rows = db.prepare('SELECT id, name, token, start_message, start_image, gateway_token, gateway_document, cnpj, downsell FROM bots').all()
    .map((r) => ({ ...r, downsell: r.downsell ? JSON.parse(r.downsell) : null }));

  let novos = 0;
  for (const row of rows) {
    const noAr = bots.find((b) => b.id === row.id);
    if (!noAr) {
      startBot(row);
      novos++;
      console.log(`bot "${row.name}" (id ${row.id}) iniciado sem restart`);
    } else if (noAr.token !== row.token) {
      trocarToken(noAr, row); // token é a conexão com o Telegram: só ele exige instância nova
    } else {
      Object.assign(noAr, row);
    }
  }
  return novos;
}

// Token mudou: derruba a instância velha e sobe outra com o token novo.
function trocarToken(entry, row) {
  entry.parando = true;
  try { entry.instance.stop('token alterado'); } catch { /* pode nem estar rodando */ }
  bots.splice(bots.indexOf(entry), 1);
  startBot(row);
  console.log(`bot "${row.name}" (id ${row.id}) religado com o token novo`);
}

sincronizarBots();
console.log(`${bots.length} bot(s) iniciados`);

const SYNC_TICK = Number(process.env.SYNC_TICK_MS) || 15_000;
setInterval(() => {
  try { sincronizarBots(); } catch (e) { console.error('sync:', e.message); }
}, SYNC_TICK).unref?.();

// Fila do downsell: sobrevive a restart porque o agendamento está no banco
const DOWNSELL_TICK = 60_000;
setInterval(() => enviarPendentes().catch((e) => console.error('downsell:', e.message)), DOWNSELL_TICK).unref?.();
enviarPendentes().catch((e) => console.error('downsell:', e.message));

const app = express();
app.use(express.json());

// Downsell (config do bot): valida e devolve mensagem de erro, ou null se ok
function validarDownsell(d) {
  if (typeof d !== 'object' || Array.isArray(d)) return 'downsell deve ser um objeto.';
  if (typeof d.enabled !== 'boolean') return 'downsell.enabled deve ser true/false.';
  // Sem isso um gatilho desconhecido salvava e nunca disparava — a campanha ficava viva na tela e morta no bot.
  if (d.trigger !== undefined && !GATILHOS.includes(d.trigger)) {
    return `downsell.trigger deve ser ${GATILHOS.join(' ou ')}.`;
  }
  if (d.audience !== undefined && !['new', 'all'].includes(d.audience)) {
    return 'downsell.audience deve ser new ou all.';
  }
  if (d.button_mode !== undefined && !['plans_discount', 'custom'].includes(d.button_mode)) {
    return 'downsell.button_mode deve ser plans_discount ou custom.';
  }
  if (!Array.isArray(d.messages)) return 'downsell.messages deve ser um array.';
  // Ligado e vazio é o pior estado possível: o painel mostra a campanha ativa e o bot nunca envia nada.
  if (d.enabled && !d.messages.length) return 'downsell ligado precisa de pelo menos uma mensagem.';
  for (const m of d.messages) {
    if (!m || typeof m.text !== 'string' || !m.text.trim()) return 'cada mensagem do downsell precisa de text.';
    if (m.text.length > 4096) return 'mensagem do downsell passa de 4096 caracteres.'; // limite do Telegram
    if (m.image !== undefined && m.image !== null && m.image !== '' && !/^https?:\/\/\S+$/.test(m.image)) {
      return 'image da mensagem do downsell deve ser uma URL http(s) de imagem ou vídeo.';
    }
    if (typeof m.delay_minutes !== 'number' || m.delay_minutes < 0) return 'delay_minutes deve ser número >= 0.';
    if (m.discount_percent !== undefined &&
        (typeof m.discount_percent !== 'number' || m.discount_percent < 0 || m.discount_percent > 100)) {
      return 'discount_percent deve ser número entre 0 e 100.';
    }
  }
  return null;
}

// Resposta pública do bot: gateway_token é segredo e nunca sai daqui
const publico = ({ id, name, start_message, start_image, gateway_token, gateway_document, cnpj, downsell }) => ({
  id, name, start_message, start_image, gateway_document, cnpj, gateway_enabled: !!gateway_token,
  downsell, plans: listPlans(id), order_bumps: listBumps(id),
});

// POST /bots — cadastra, ou atualiza se o token já existir (o token é a identidade do bot)
// Body: { "name", "token", "start_message", "start_image", "plans": [...], "order_bumps": [...], "downsell": { ... } }
app.post('/bots', (req, res) => {
  const {
    name, token, start_message = null, start_image = null,
    gateway_token = null, gateway_document = null, cnpj = null,
    plans = [], order_bumps = [], downsell = null,
  } = req.body || {};

  if (typeof name !== 'string' || !name.trim() || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'name e token são obrigatórios.' });
  }
  if (downsell !== null) {
    const erro = validarDownsell(downsell);
    if (erro) return res.status(400).json({ error: erro });
  }
  if (start_message !== null && typeof start_message !== 'string') {
    return res.status(400).json({ error: 'start_message deve ser texto.' });
  }
  if (start_image !== null && !/^https?:\/\/\S+$/.test(start_image)) {
    return res.status(400).json({ error: 'start_image deve ser uma URL http(s) de imagem ou vídeo.' });
  }
  if (gateway_token !== null && (typeof gateway_token !== 'string' || !gateway_token.trim())) {
    return res.status(400).json({ error: 'gateway_token deve ser o header authorization do gateway (ex: "Basic c2tf...").' });
  }
  if (gateway_document !== null && !/^\d{11}$|^\d{14}$/.test(gateway_document)) {
    return res.status(400).json({ error: 'gateway_document deve ser CPF (11) ou CNPJ (14 dígitos), só números.' });
  }
  if (cnpj !== null && !/^\d{11}$|^\d{14}$/.test(cnpj)) {
    return res.status(400).json({ error: 'cnpj deve ser CPF (11) ou CNPJ (14 dígitos), só números.' });
  }
  if (!Array.isArray(plans) || !Array.isArray(order_bumps)) {
    return res.status(400).json({ error: 'plans e order_bumps devem ser arrays.' });
  }
  for (const p of plans) {
    if (!p || typeof p.name !== 'string' || !p.name.trim() || typeof p.price !== 'number') {
      return res.status(400).json({ error: 'cada plano precisa de name (texto) e price (número).' });
    }
    if (p.vip_groups !== undefined && !Array.isArray(p.vip_groups)) {
      return res.status(400).json({ error: 'vip_groups deve ser um array.' });
    }
    for (const g of p.vip_groups || []) {
      if (!g || (typeof g.idGroup !== 'string' && typeof g.idGroup !== 'number') || `${g.idGroup}`.trim() === '') {
        return res.status(400).json({ error: 'cada grupo VIP precisa de idGroup.' });
      }
    }
  }
  for (const b of order_bumps) {
    if (!b || typeof b.name !== 'string' || !b.name.trim() || typeof b.price !== 'number') {
      return res.status(400).json({ error: 'cada order bump precisa de name (texto) e price (número).' });
    }
  }
  if (order_bumps.length > 31) {
    return res.status(400).json({ error: 'máximo de 31 order bumps por bot.' });
  }

  const existente = db.prepare('SELECT id FROM bots WHERE token = ?').get(token.trim());

  let row;
  db.exec('BEGIN');
  try {
    if (existente) {
      // ponytail: plans/bumps do body substituem os antigos (deleta e regrava). Sem merge por id —
      // mande a lista completa. `purchases` guarda o plan_id antigo, que pode não existir mais.
      db.prepare(`UPDATE bots SET name = ?, start_message = ?, start_image = ?,
                  gateway_token = ?, gateway_document = ?, cnpj = ?, downsell = ? WHERE id = ?`)
        .run(name.trim(), start_message, start_image, gateway_token, gateway_document, cnpj,
             downsell && JSON.stringify(downsell), existente.id);
      db.prepare('DELETE FROM plans WHERE bot_id = ?').run(existente.id);
      db.prepare('DELETE FROM order_bumps WHERE bot_id = ?').run(existente.id);
    }
    const id = existente
      ? existente.id
      : Number(db.prepare(`INSERT INTO bots (name, token, start_message, start_image, gateway_token, gateway_document, cnpj, downsell)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(name.trim(), token.trim(), start_message, start_image, gateway_token, gateway_document, cnpj,
               downsell && JSON.stringify(downsell)).lastInsertRowid);
    row = { id, name: name.trim(), token: token.trim(), start_message, start_image, gateway_token, gateway_document, cnpj, downsell };

    const insertPlan = db.prepare('INSERT INTO plans (bot_id, name, price, data) VALUES (?, ?, ?, ?)');
    for (const p of plans) insertPlan.run(row.id, p.name.trim(), p.price, JSON.stringify(p));

    const insertBump = db.prepare('INSERT INTO order_bumps (bot_id, name, price, data) VALUES (?, ?, ?, ?)');
    for (const b of order_bumps) insertBump.run(row.id, b.name.trim(), b.price, JSON.stringify(b));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Já no ar: só troca a config em memória — o token não mudou, então a instância continua a mesma.
  const noAr = bots.find((b) => b.id === row.id);
  if (noAr) Object.assign(noAr, row);
  else startBot(row);

  res.status(existente ? 200 : 201).json(publico(row));
});

app.get('/bots', (req, res) => res.json(bots.map(publico)));

// GET /bots/cnpj/:cnpj — bots de uma mesma empresa/pessoa (dígitos do cpf/cnpj, com ou sem máscara)
app.get('/bots/cnpj/:cnpj', (req, res) => {
  const cnpj = req.params.cnpj.replace(/\D/g, '');
  if (!/^\d{11}$|^\d{14}$/.test(cnpj)) {
    return res.status(400).json({ error: 'cnpj deve ser CPF (11) ou CNPJ (14 dígitos).' });
  }
  res.json(bots.filter((b) => b.cnpj === cnpj).map(publico));
});

// GET /bots/:id?cnpj=... — bot no mesmo formato do payload do POST /bots (com token e
// gateway_token em claro, diferente de `publico()`), pronto pra reenviar num PUT/edição.
// `cnpj` é obrigatório e precisa bater com o dono do bot — sem ele (ou errado), nem confirma
// que o id existe: sempre 404, pra não vazar id de bot de outra empresa/pessoa por enumeração.
app.get('/bots/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id deve ser um número inteiro.' });

  const cnpj = String(req.query.cnpj || '').replace(/\D/g, '');
  if (!/^\d{11}$|^\d{14}$/.test(cnpj)) {
    return res.status(400).json({ error: 'cnpj deve ser CPF (11) ou CNPJ (14 dígitos), passado por query (?cnpj=...).' });
  }

  const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!row || row.cnpj !== cnpj) return res.status(404).json({ error: 'bot não encontrado.' });

  res.json({
    id: row.id,
    name: row.name,
    token: row.token,
    start_message: row.start_message,
    start_image: row.start_image,
    gateway_token: row.gateway_token,
    gateway_document: row.gateway_document,
    cnpj: row.cnpj,
    downsell: row.downsell ? JSON.parse(row.downsell) : null,
    plans: listPlans(id),
    order_bumps: listBumps(id),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

// ponytail: try/catch porque bot que falhou no launch não está rodando
// Depois de parar os bots, sai: o servidor HTTP segurava o processo vivo e o SIGTERM
// (pm2, test-upsert) deixava um bot.js órfão rodando para sempre.
const stop = (sig) => {
  bots.forEach((b) => { b.parando = true; try { b.instance.stop(sig); } catch {} });
  process.exit(0);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

module.exports = { db, bots, startBot, trocarToken, menuMode, ehVideo, enviarMidiaChat, boasVindasText, pixMessage, pixPayload, cpfAleatorio, gatewayFetch, consultarStatus, esperarPago, centavos, valorPix, PAGO, manterVivo, sincronizarBots, validarDownsell, agendarDownsell, cancelarDownsell, registrarCompra, enviarPendentes, comDesconto, menuText, menuKeyboard, bumpPrompt, summaryText, vipLinks, listPlans, listBumps };
