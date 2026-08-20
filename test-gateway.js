// ponytail: check da consulta de status contra um gateway falso (GATEWAY_URL aponta para ele)
// Isola o processo antes de carregar bot.js: banco em dir temporário e porta livre,
// senão o teste sobe os bots de verdade e briga com o servidor já rodando na 3000.
process.env.PORT = '0';
process.chdir(require('node:fs').mkdtempSync(`${require('node:os').tmpdir()}/bottest-`));
const assert = require('node:assert');
const http = require('node:http');

let chamadas = 0; // /transaction-status/demora só paga na 3ª consulta

const respostas = {
  '/transaction-status/pago': [200, { success: true, data: { id: 'pago', status: 'paid' } }],
  '/transaction-status/aberto': [200, { success: true, data: { id: 'aberto', status: 'waiting_payment' } }],
  '/transaction-status/sumiu': [404, { success: false, error: 'No transaction found' }],
  '/transaction-status/semtoken': [401, { success: false, error: 'Unauthorized' }],
};

const server = http.createServer((req, res) => {
  const demora = req.url === '/transaction-status/demora'
    ? [200, { success: true, data: { status: ++chamadas >= 3 ? 'paid' : 'waiting_payment' } }]
    : null;
  const [code, body] = demora || respostas[req.url] || [405, { success: false, error: 'Method not allowed' }];
  assert.equal(req.headers.authorization, 'Basic abc', 'authorization do bot vai no header');
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
});

(async () => {
  await new Promise((ok) => server.listen(0, ok));
  process.env.GATEWAY_URL = `http://localhost:${server.address().port}`;
  const { consultarStatus, esperarPago, PAGO } = require('./bot');

  assert.equal(await consultarStatus('Basic abc', 'pago'), 'paid');
  assert.ok(PAGO.includes(await consultarStatus('Basic abc', 'pago')));
  assert.ok(!PAGO.includes(await consultarStatus('Basic abc', 'aberto')));
  await assert.rejects(consultarStatus('Basic abc', 'sumiu'), /No transaction found/);
  await assert.rejects(consultarStatus('Basic abc', 'semtoken'), /Unauthorized/);
  // Checagem automática: paga no meio do caminho → devolve o status sem ninguém clicar
  assert.equal(await esperarPago('Basic abc', 'demora', 2000, 10), 'paid');
  assert.equal(chamadas, 3, 'parou de consultar assim que pagou');

  // Não pagou dentro da janela → null, e aí o botão manual assume
  assert.equal(await esperarPago('Basic abc', 'aberto', 60, 10), null);
  // Gateway fora do ar não derruba a espera, só não confirma
  assert.equal(await esperarPago('Basic abc', 'sumiu', 60, 10), null);

  console.log('ok');
})().then(() => 0, (err) => { console.error(err.message); return 1; })
  .then((code) => { server.close(); process.exit(code); });
