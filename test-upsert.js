// ponytail: check do upsert por token — sobe bot.js num dir temporário (bots.db é relativo ao cwd)
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');

const portaLivre = () => new Promise((ok) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); });
});

const dir = fs.mkdtempSync(`${os.tmpdir()}/botupsert-`);
let proc;

const body = (extra) => ({
  name: 'teste', token: '123:TOKEN-DE-TESTE', plans: [{ name: 'bronze', price: 10 }], ...extra,
});

(async () => {
  const porta = await portaLivre(); // não colide com o bot de verdade na 3000
  const url = `http://localhost:${porta}/bots`;
  const post = (b) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  }).then(async (r) => [r.status, await r.json()]);

  proc = spawn(process.execPath, [`${__dirname}/bot.js`], {
    cwd: dir, env: { ...process.env, PORT: String(porta), SYNC_TICK_MS: '200' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50 && !(await fetch(url).catch(() => null)); i++) await new Promise((r) => setTimeout(r, 100));

  const [s1, criado] = await post(body({ start_message: 'v1' }));
  assert.equal(s1, 201);

  const [s2, atualizado] = await post(body({
    start_message: 'v2', start_image: 'https://x/i.png', plans: [{ name: 'ouro', price: 99 }],
  }));
  assert.equal(s2, 200, 'token repetido atualiza, não cria');
  assert.equal(atualizado.id, criado.id, 'mesmo bot');
  assert.equal(atualizado.start_message, 'v2');
  assert.equal(atualizado.start_image, 'https://x/i.png');
  assert.deepEqual(atualizado.plans.map((p) => p.name), ['ouro'], 'plans do body substituem os antigos');

  // Gateway: token sem documento não passa, e o token nunca volta na resposta
  const outro = { token: '456:OUTRO-BOT' }; // bot separado: o upsert substitui tudo do bot alvo
  const [s3, semDoc] = await post(body({ ...outro, gateway_token: 'Basic abc' }));
  assert.equal(s3, 201, 'gateway_token sem documento passa: o CPF é gerado na hora');
  assert.equal(semDoc.gateway_document, null);
  const [, comGateway] = await post(body({ ...outro, gateway_token: 'Basic abc', gateway_document: '48001582817' }));
  assert.equal(comGateway.gateway_enabled, true);
  assert.equal(comGateway.gateway_document, '48001582817');
  assert.ok(!('gateway_token' in comGateway), 'gateway_token é segredo, não sai na API');

  const lista = await fetch(url).then((r) => r.json());
  assert.equal(lista.filter((b) => b.token === undefined && b.id === criado.id).length, 1, 'um bot por token');
  // GET /bots lê a config viva (a que os handlers usam): já veio atualizada, sem restart
  assert.equal(lista.find((b) => b.id === criado.id).start_message, 'v2');

  // Alteração feita direto no banco por fora também entra sozinha, no tick do sync
  const db = new (require('node:sqlite').DatabaseSync)(`${dir}/bots.db`);
  db.prepare('UPDATE bots SET start_message = ? WHERE id = ?').run('v3', criado.id);
  db.close();
  for (let i = 0; i < 50; i++) {
    const b = (await fetch(url).then((r) => r.json())).find((x) => x.id === criado.id);
    if (b.start_message === 'v3') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const viva = (await fetch(url).then((r) => r.json())).find((b) => b.id === criado.id);
  assert.equal(viva.start_message, 'v3', 'config editada no banco entra sem restart');
  console.log('ok');
})().then(() => 0, (err) => { console.error(err.message); return 1; })
  .then((code) => {
    proc?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(code); // sockets keep-alive do fetch seguram o processo
  });
