// ponytail: check só do que tem branch — como o menu sai com/sem start_image
// Isola o processo antes de carregar bot.js: banco em dir temporário e porta livre,
// senão o teste sobe os bots de verdade e briga com o servidor já rodando na 3000.
process.env.PORT = '0';
process.chdir(require('node:fs').mkdtempSync(`${require('node:os').tmpdir()}/bottest-`));
const assert = require('node:assert');
const { menuMode, ehVideo, boasVindasText, menuText, pixMessage, pixPayload, cpfAleatorio, centavos } = require('./bot');

assert.equal(menuMode(null, 'oi'), 'text');
assert.equal(menuMode('https://x/i.png', 'a'.repeat(1024)), 'photo_caption');
assert.equal(menuMode('https://x/i.png', 'a'.repeat(1025)), 'photo_then_text');
// start_image também aceita vídeo: a extensão da URL decide foto x vídeo
assert.equal(ehVideo('https://x/v.mp4'), true);
assert.equal(ehVideo('https://x/v.MOV?token=1'), true);
assert.equal(ehVideo('https://x/v.webm#t=2'), true);
assert.equal(ehVideo('https://x/i.png'), false);
assert.equal(ehVideo('https://x/mp4/i.jpg'), false); // extensão é o fim do caminho, não qualquer pedaço da URL
// /start manda só as boas-vindas: os planos ficam para o botão "Acessar agora"
assert.equal(boasVindasText({ name: 'x' }), 'Olá! Eu sou o bot x.');
assert.equal(boasVindasText({ name: 'x', start_message: 'oi' }), 'oi');
assert.ok(!boasVindasText({ name: 'x', start_message: 'oi' }).includes('Planos'));
assert.equal(
  menuText([{ name: 'bronze', price: 29.9, duration: 'lifetime' }]),
  '📦 Planos disponíveis:\n• bronze — R$ 29,90 (lifetime)',
);
assert.match(menuText([]), /Nenhum plano/);

// PIX: valor em centavos e a mensagem no formato pedido
assert.equal(centavos(9.9), 990);
assert.equal(centavos(149.9), 14990);
assert.equal(centavos(0.1 + 0.2), 30); // float não pode virar 30.000000000000004

const pix = pixMessage('1 MES DE ACESSO', 9.9, '00020126850014br.gov.bcb.pix***6304F326');
assert.ok(pix.startsWith('🌟 Você selecionou o seguinte plano:'));
assert.ok(pix.includes('🎁 Plano: 1 MES DE ACESSO'));
assert.ok(pix.includes('💰 Valor: R$9,90'));
assert.ok(pix.includes('<code>00020126850014br.gov.bcb.pix***6304F326</code>'), 'copia e cola em <code> para copiar com 1 toque');
assert.ok(pix.endsWith('clique no botão abaixo para verificar o status:'));
assert.ok(pixMessage('Plano <b>hack</b>', 1, 'x').includes('&lt;b&gt;'), 'nome do plano escapado no HTML');

// Corpo enviado ao gateway: tudo em centavos, um item por produto
const payload = pixPayload(
  { gateway_document: '48001582817' },
  { id: 7, first_name: 'João', last_name: 'Silva' },
  [{ name: 'plano bronze', price: 29.9 }, { name: 'Ebook', price: 19.9 }],
  49.8,
);
assert.equal(payload.amount, 4980);
assert.equal(payload.amount, payload.items.reduce((t, i) => t + i.unitPrice * i.quantity, 0), 'soma dos itens = amount');
assert.equal(payload.customer.name, 'João Silva');
assert.equal(payload.customer.document.number, '48001582817');
assert.deepEqual(payload.items[0], { title: 'plano bronze', unitPrice: 2990, quantity: 1 });
assert.equal(pixPayload({}, { id: 7 }, [], 0).customer.name, 'telegram 7'); // sem nome no Telegram

// Sem gateway_document, a cobrança vai com um CPF gerado — precisa passar no dígito verificador
const dvOk = (cpf) => {
  const d = [...cpf].map(Number);
  const dv = (base) => (base.reduce((t, x, i) => t + x * (base.length + 1 - i), 0) * 10) % 11 % 10;
  return cpf.length === 11 && dv(d.slice(0, 9)) === d[9] && dv(d.slice(0, 10)) === d[10];
};
for (let i = 0; i < 500; i++) {
  const cpf = cpfAleatorio();
  assert.ok(dvOk(cpf), `CPF inválido: ${cpf}`);
  assert.ok(new Set(cpf).size > 1, 'CPF de dígito repetido é recusado por validador');
}
assert.ok(dvOk(pixPayload({}, { id: 7 }, [], 0).customer.document.number));
assert.equal(pixPayload({ gateway_document: '48001582817' }, { id: 7 }, [], 0).customer.document.number, '48001582817');

console.log('ok');
process.exit(0); // bot.js sobe servidor/timers ao ser importado
