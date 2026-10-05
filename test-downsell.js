// ponytail: check dos gatilhos do downsell — 'start' e 'abandoned_checkout' agendam sozinhos
// Isola o processo antes de carregar bot.js: banco em dir temporário e porta livre,
// senão o teste sobe os bots de verdade e briga com o servidor já rodando na 3000.
process.env.PORT = '0';
process.chdir(require('node:fs').mkdtempSync(`${require('node:os').tmpdir()}/botdown-`));
const assert = require('node:assert');
const { db, agendarDownsell, cancelarDownsell, registrarCompra, validarDownsell } = require('./bot');

// scheduled_messages/purchases têm FK para bots (o node:sqlite cobra), então os bots do teste existem de verdade
const novoBot = db.prepare('INSERT INTO bots (id, name, token) VALUES (?, ?, ?)');
for (let i = 1; i <= 7; i++) novoBot.run(i, `bot${i}`, `${i}:TOKEN-DE-TESTE`);

const msgs = [
  { delay_minutes: 5, discount_percent: 5, text: 'ficou esperando' },
  { delay_minutes: 10, discount_percent: 10, text: 'última chance' },
];
const cfg = (id, extra) => ({ id, name: `bot${id}`, downsell: { enabled: true, audience: 'all', messages: msgs, ...extra } });
const pendentes = (botId) => db.prepare(
  'SELECT msg_index, send_at FROM scheduled_messages WHERE bot_id = ? AND canceled = 0 AND sent_at IS NULL ORDER BY msg_index'
).all(botId);

// Gatilho tem que bater: config de /start não é disparada pelo checkout, e vice-versa
assert.equal(agendarDownsell(cfg(1, { trigger: 'start' }), 111, 'start'), 2);
assert.equal(agendarDownsell(cfg(2, { trigger: 'start' }), 222, 'abandoned_checkout'), 0);
assert.equal(agendarDownsell(cfg(3, { trigger: 'abandoned_checkout' }), 333, 'start'), 0);
assert.equal(agendarDownsell(cfg(4, { trigger: 'abandoned_checkout' }), 444, 'abandoned_checkout'), 2);
// Sem trigger na config o padrão continua sendo o /start
assert.equal(agendarDownsell(cfg(5, {}), 555, 'start'), 2);

// Delay vira horário de envio: 5 e 10 minutos à frente
const t = Math.floor(Date.now() / 1000);
const fila = pendentes(4);
assert.equal(fila.length, 2);
assert.ok(Math.abs(fila[0].send_at - (t + 300)) <= 2, 'msg 0 agendada para ~5min');
assert.ok(Math.abs(fila[1].send_at - (t + 600)) <= 2, 'msg 1 agendada para ~10min');

// /start repetido não duplica (UNIQUE), mas checkout abandonado reinicia a contagem
assert.equal(agendarDownsell(cfg(1, { trigger: 'start' }), 111, 'start'), 0);
assert.equal(agendarDownsell(cfg(4, { trigger: 'abandoned_checkout' }), 444, 'abandoned_checkout'), 2);
assert.equal(pendentes(4).length, 2, 'reagendar não acumula linha, substitui');

// Abandonar de novo depois de já ter recebido a 1ª mensagem volta a agendar as duas
db.prepare('UPDATE scheduled_messages SET sent_at = ? WHERE bot_id = 4 AND msg_index = 0').run(t);
assert.equal(pendentes(4).length, 1);
assert.equal(agendarDownsell(cfg(4, { trigger: 'abandoned_checkout' }), 444, 'abandoned_checkout'), 2);
assert.equal(pendentes(4).length, 2);

// Comprou: a fila pendente daquele bot é cancelada e audience 'new' não agenda mais
assert.equal(pendentes(1).length, 2);
registrarCompra(1, 111, 9, 10);
assert.equal(pendentes(1).length, 0, 'compra cancela o downsell pendente');
assert.equal(agendarDownsell(cfg(1, { trigger: 'start', audience: 'new' }), 111, 'start'), 0);
assert.equal(agendarDownsell(cfg(1, { trigger: 'start', audience: 'all' }), 999, 'start'), 2, 'outro chat não é afetado');
assert.equal(cancelarDownsell(1, 999), 2);

// Desligado ou sem mensagem nunca agenda
assert.equal(agendarDownsell(cfg(6, { trigger: 'start', enabled: false }), 666, 'start'), 0);
assert.equal(agendarDownsell(cfg(7, { trigger: 'start', messages: [] }), 777, 'start'), 0);

// Mídia opcional por mensagem: mesma regra de URL do start_image
assert.equal(validarDownsell({ enabled: true, messages: [{ ...msgs[0], image: 'https://x/v.mp4' }] }), null);
assert.equal(validarDownsell({ enabled: true, messages: [{ ...msgs[0], image: '' }] }), null, 'vazio = sem mídia');
assert.equal(validarDownsell({ enabled: true, messages: [{ ...msgs[0] }] }), null, 'image é opcional');
assert.match(validarDownsell({ enabled: true, messages: [{ ...msgs[0], image: 'ftp://x/v.mp4' }] }), /URL http/);

// Validação: valor fora da lista é 400 na API, não campanha morta em silêncio
const base = { enabled: true, messages: msgs };
assert.equal(validarDownsell({ ...base, trigger: 'abandoned_checkout' }), null);
assert.equal(validarDownsell({ ...base, trigger: 'start' }), null);
assert.equal(validarDownsell(base), null, 'trigger é opcional');
assert.match(validarDownsell({ ...base, trigger: 'carrinho' }), /trigger deve ser/);
assert.match(validarDownsell({ ...base, audience: 'vips' }), /audience deve ser/);
assert.match(validarDownsell({ ...base, button_mode: 'nenhum' }), /button_mode deve ser/);
// Toggle ligado sem mensagem nenhuma: era o estado do bot em produção que "não mandava downsell"
assert.match(validarDownsell({ enabled: true, messages: [] }), /pelo menos uma mensagem/);
assert.equal(validarDownsell({ enabled: false, messages: [] }), null, 'desligado e vazio é config válida');

console.log('ok');
process.exit(0); // bot.js sobe servidor/timers ao ser importado
