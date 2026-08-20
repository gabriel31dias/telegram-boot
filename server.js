const express = require('express');
const { Telegraf } = require('telegraf');
const { BOT_TOKEN } = require('./config');

const app = express();
app.use(express.json());

const bot = new Telegraf(BOT_TOKEN);

// POST /message  →  envia mensagem no grupo
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

// POST /invite  →  gera link de convite único (expira em 1 uso ou 1 hora)
// Body: { "group_id": "-1001234567890" }
app.post('/invite', async (req, res) => {
  const { group_id } = req.body;

  if (!group_id) {
    return res.status(400).json({ error: 'group_id é obrigatório no body.' });
  }

  try {
    const link = await bot.telegram.createChatInviteLink(group_id, {
      creates_join_request: false,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hora
    });

    res.json({ invite_link: link.invite_link });
  } catch (error) {
    console.error('Erro ao gerar link:', error);
    res.status(500).json({ error: 'Não foi possível gerar o link de convite.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
