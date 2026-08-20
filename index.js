require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN não definido no .env');

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// Mapa: invite_link → reference
const inviteLinks = new Map();

// ─── ROTAS EXPRESS ────────────────────────────────────────────────────────────

// POST /invite
// Body: { "group_id": "-1001234567890", "reference": "qualquer_dado_seu" }
app.post('/invite', async (req, res) => {
  const { group_id, reference } = req.body;

  if (!group_id || !reference) {
    return res.status(400).json({ error: 'group_id e reference são obrigatórios.' });
  }

  try {
    const link = await bot.telegram.createChatInviteLink(group_id, {
      creates_join_request: true,
      expire_date: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hora
    });

    inviteLinks.set(link.invite_link, { reference, group_id });
    console.log(`Link criado: ${link.invite_link} → reference: ${reference}`);

    res.json({ invite_link: link.invite_link });
  } catch (error) {
    console.error('Erro ao gerar link:', error);
    res.status(500).json({ error: 'Não foi possível gerar o link de convite.' });
  }
});

// POST /message
// Body: { "group_id": "-1001234567890", "text": "Olá!" }
app.post('/message', async (req, res) => {
  const { group_id, text } = req.body;

  if (!group_id || !text) {
    return res.status(400).json({ error: 'group_id e text são obrigatórios.' });
  }

  try {
    await bot.telegram.sendMessage(group_id, text);
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ error: 'Não foi possível enviar a mensagem.' });
  }
});

// ─── HANDLERS DO BOT ──────────────────────────────────────────────────────────

bot.command('meuid', (ctx) => {
  if (ctx.chat.type === 'private') {
    ctx.reply('⚠️ Você está no privado. Adicione-me ao grupo e use /meuid lá dentro.');
  } else {
    ctx.reply(`📌 O ID deste grupo é: \n\n<code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
  }
});

// Solicitação de entrada via link com creates_join_request: true
bot.on('chat_join_request', async (ctx) => {
  const { from, invite_link, chat } = ctx.chatJoinRequest;
  const link = invite_link?.invite_link;
  const entry = inviteLinks.get(link);

  console.log('─── Solicitação de entrada ───');
  console.log('Usuário:', from.id, from.first_name, from.username || '');
  console.log('Link usado:', link || 'desconhecido');
  console.log('Reference:', entry ? entry.reference : 'não rastreado');

  // Aprova automaticamente
  await ctx.approveChatJoinRequest(from.id);

  // Remove o link do mapa após uso
  if (link) inviteLinks.delete(link);
});

bot.on('new_chat_members', (ctx) => {
  for (const member of ctx.message.new_chat_members) {
    console.log('Entrou:', member.username || member.first_name, '| ID:', member.id);
  }
});

bot.on('left_chat_member', (ctx) => {
  const m = ctx.message.left_chat_member;
  console.log('Saiu:', m.username || m.first_name);
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

const launchBot = async (attempt = 1) => {
  try {
    await bot.launch();
    console.log('Bot iniciado com sucesso.');
  } catch (err) {
    console.error(`Bot launch error (tentativa ${attempt}):`, err.message);
    if (attempt < 10) {
      console.log(`Tentando novamente em 5s...`);
      setTimeout(() => launchBot(attempt + 1), 5000);
    } else {
      process.exit(1);
    }
  }
};

launchBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
