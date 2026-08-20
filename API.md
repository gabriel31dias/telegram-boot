# API — bot.js

`node bot.js` (porta 3000, `PORT` para trocar). Banco: `bots.db` (SQLite), criado sozinho.

Nada aqui pede reiniciar o node. A cada 15s (`SYNC_TICK_MS`) o processo espelha a tabela `bots` no que está rodando: bot novo sobe, e a config de bot já no ar (`name`, `start_message`, `start_image`, `downsell`) é atualizada em memória — inclusive alteração feita direto no banco por outro processo. Pela rota `POST /bots` vale na hora, sem esperar o tick. `plans` e `order_bumps` nem dependem disso: são lidos do banco a cada mensagem. Trocar o `token` é o único caso que derruba a instância e sobe outra (é ele que conecta no Telegram) — também automático.

Config nova vale no **próximo** `/start` ou `/planos`: mensagem já enviada não muda sozinha.

Bot que cai volta sozinho: o polling é relançado com backoff de 5s, 10s, 20s… até o teto de 5 min, e o contador zera depois de 1 min de pé (`RETRY_BASE_MS` muda a base). Erro dentro de um handler é capturado no `bot.catch` e não derruba o bot. Cada bot cai e volta por conta própria — não afeta os outros.

## POST /bots — cadastrar ou atualizar bot

Grava o bot + planos + order bumps e já sobe o bot. Campos: `name` e `token` obrigatórios, `start_message`, `start_image`, `gateway_token`, `gateway_document`, `plans` e `order_bumps` opcionais.

**O token é a identidade do bot**: se já existir um bot com aquele token, a rota **atualiza** em vez de criar outro (responde `200` com o mesmo `id`; cadastro novo responde `201`). `plans` e `order_bumps` do body **substituem** os antigos — mande a lista completa, não só o que mudou. Bot já no ar pega a config nova na hora, sem restart (o token não mudou, a instância é a mesma).

O `/start` é em dois passos: primeiro a mensagem de boas-vindas (`start_message` + `start_image`) com um botão **🚀 Acessar agora**; só ao clicar é que vem a lista de planos com um botão por plano. `/planos` pula direto para a lista.

`start_image` é a URL (http/https) de uma imagem enviada com a mensagem de boas-vindas, acima do texto. Vai como foto com o texto na legenda; se o texto passar de 1024 caracteres (limite de legenda do Telegram), a foto vai sozinha e o texto/botão logo em seguida. URL fora do ar não derruba o menu — cai para só texto. Cada plano/bump precisa de `name` e `price`; o resto do objeto é salvo como está.

Os `order_bumps` são do bot (podem ser vários, máx. 31) e são oferecidos na ordem de cadastro — só nos planos com `order_bump.enabled: true`.

`downsell` é config do bot (opcional, salvo como JSON na coluna `bots.downsell`):

```json
"downsell": {
  "enabled": true,
  "trigger": "start",
  "audience": "new",
  "button_mode": "plans_discount",
  "messages": [
    { "delay_minutes": 5,  "discount_percent": 5,  "text": "Ficou na dúvida? 5% off por tempo limitado." },
    { "delay_minutes": 60, "discount_percent": 10, "text": "🔥 Última chance! Desconto exclusivo só para você — escolha um plano abaixo." }
  ]
}
```

| campo | o que é |
|---|---|
| `enabled` | o toggle "Downsell Ativo" (obrigatório, booleano) |
| `trigger` | gatilho — `"start"` = no /start (1ª entrada) |
| `audience` | destinatários — `"new"` = novos (nunca compraram) |
| `button_mode` | modo dos botões — `"plans_discount"` = planos do bot com desconto |
| `messages[].delay_minutes` | quanto tempo depois do gatilho (obrigatório, ≥ 0) |
| `messages[].discount_percent` | desconto da mensagem, 0 a 100 (opcional) |
| `messages[].text` | texto, até 4096 caracteres (obrigatório) |

Como funciona: no `/start` em chat privado, cada mensagem é enfileirada na tabela `scheduled_messages` com o horário de envio (`delay_minutes`). Um tick de 1 minuto varre a fila e envia o que venceu — **sempre pelo bot dono da linha (`bot_id`)**, nunca por outro: em chat privado o `chat_id` é o mesmo para todos os bots.

- Fila no banco, então o agendamento **sobrevive a restart** do processo.
- `/start` repetido não duplica (`UNIQUE(bot_id, chat_id, msg_index)`).
- `audience: "new"` pula quem já tem compra registrada **naquele bot**; comprar em um bot não mexe no downsell dos outros.
- Ao fechar o pedido, a compra é registrada em `purchases` e o downsell pendente daquele bot é cancelado.
- `button_mode: "plans_discount"` manda os planos com o `discount_percent` aplicado. O desconto viaja no `callback_data` (`plan:<id>:<pct>`) e chega no resumo: `• plano ouro — R$ 134,91 (de R$ 149,90, -10%)`. Order bump entra pelo preço cheio.
- Falha no envio (usuário bloqueou o bot) cancela aquela linha em vez de tentar para sempre.

## Pagamento PIX

`gateway_token` é o header `authorization` do gateway (`Basic c2tf...`), salvo em `bots.gateway_token`. `gateway_document` é o CPF/CNPJ (só números) que vai no `customer.document` da cobrança. **Opcional**: sem ele, cada cobrança leva um CPF gerado na hora, com dígitos verificadores válidos — documento fictício, não o do comprador; gateway com KYC pode recusar ou marcar. O `gateway_token` nunca volta nas respostas da API; o que aparece é `gateway_enabled: true`.

Com gateway cadastrado, o fluxo depois de escolher o plano é: resumo com os order bumps aceitos → cobrança PIX criada em `POST {GATEWAY_URL}/transactions` com o total em **centavos** → foto do QR Code com a legenda:

```
🌟 Você selecionou o seguinte plano:

🎁 Plano: 1 MES DE ACESSO
💰 Valor: R$9,90

💠 Pague via Pix Copia e Cola (ou QR Code em alguns bancos):

00020126850014br.gov.bcb.pix...6304F326

👆 Toque na chave PIX acima para copiá-la

‼️ Após o pagamento, clique no botão abaixo para verificar o status:
```

O copia e cola vai em `<code>`, então um toque copia.

Assim que o QR é enviado, o bot confere sozinho por **1 minuto** (a cada 5s): se o pagamento cair nesse tempo, a confirmação e os links chegam sem ninguém clicar. Passou disso, o botão que já está na tela assume. `AUTO_CHECK_MS` e `AUTO_CHECK_TOTAL_MS` mudam o intervalo e a janela.

O botão **✅ Verificar pagamento**: ele consulta `GET {GATEWAY_URL}/transaction-status/{id}` (status em `data.status`) e, se for `paid`/`approved`, registra a compra, cancela o downsell e manda os links dos grupos VIP. Erro do gateway (`{"success": false, "error": "..."}`) vira aviso para o comprador, não trava o fluxo. Enquanto não cair, responde que ainda não identificou — pode clicar quantas vezes quiser: a compra só é registrada uma vez, e clicar numa cobrança já confirmada só reenvia os links. A checagem automática e o botão não entregam em dobro.

A cobrança fica em `transactions` (id do gateway, chat, plano, total, status). O comprador vira `customer` com o nome do Telegram e e-mail `<telegram_id>@telegram.bot`; o documento é o `gateway_document` do bot ou, na falta dele, um CPF gerado por cobrança.

**Sem `gateway_token` o bot entrega o acesso direto**, sem cobrar — é como os bots antigos funcionam.

Ajustes por env: `GATEWAY_URL` (default `https://api.bluevisionsolucoes.com.br/functions/v1`). O QR é renderizado por `api.qrserver.com` a partir do copia e cola; se o serviço cair, a mensagem vai sem imagem e o copia e cola paga do mesmo jeito.

`vip_groups` é por plano: `[{ "idGroup": "-1001234567890", "name": "Sala VIP" }]` (`name` opcional, só rótulo). O link é gerado na hora pela API do Telegram a partir do `idGroup` — **o bot precisa ser admin do grupo** com permissão de convidar.

```bash
curl -X POST http://localhost:3000/bots \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "gabriel",
    "token": "8801055027:AAGXpHlYLJ-xURO0Fwr3Mum2tL-CDFeehrM",
    "start_message": "Bem-vindo! Escolha seu plano 👇",
    "start_image": "https://exemplo.com/banner.jpg",
    "gateway_token": "Basic c2tfbGl2ZV8uLi46eA==",
    "gateway_document": "48001582817",
    "plans": [
      {
        "name": "plano bronze",
        "price": 29.90,
        "duration": "lifetime",
        "telegram_button_color": "default",
        "deliverables": [{ "title": "Senha do curso", "content": "Conteúdo enviado após pagamento" }],
        "vip_groups": [{ "idGroup": "-1001234567890", "name": "Sala VIP" }],
        "order_bump": { "enabled": false }
      },
      {
        "name": "plano prata",
        "price": 59.90,
        "duration": "monthly",
        "telegram_button_color": "default",
        "deliverables": [{ "title": "Senha do curso", "content": "Conteúdo enviado após pagamento" }],
        "vip_groups": [{ "idGroup": "-1001234567890", "name": "Sala VIP" }],
        "order_bump": { "enabled": false }
      },
      {
        "name": "plano ouro",
        "price": 149.90,
        "duration": "yearly",
        "telegram_button_color": "default",
        "deliverables": [
          { "title": "Senha do curso", "content": "Conteúdo enviado após pagamento" },
          { "title": "Mentoria", "content": "Link do grupo de mentoria" }
        ],
        "vip_groups": [{ "idGroup": "-1001234567890", "name": "Sala VIP" }],
        "order_bump": { "enabled": true }
      }
    ],
    "order_bumps": [
      { "name": "Ebook bônus", "price": 19.90, "description": "PDF com 50 receitas" },
      { "name": "Grupo VIP 30 dias", "price": 9.90 },
      { "name": "Mentoria 1h", "price": 97.00 }
    ]
  }'
```

Respostas: `201` com `{ id, name, start_message, plans, order_bumps }` · `400` campo inválido · `409` token já cadastrado.

## GET /bots — listar

```bash
curl http://localhost:3000/bots
```

## No Telegram

`/start` e `/planos` → `start_message` + lista de planos + um botão por plano. Outros comandos: `/groupid`, `/info`.

Ao clicar num plano:

1. confirma o plano escolhido;
2. se o plano tem `order_bump.enabled`, oferece os bumps **um por um**, cada um com `✅ Adicionar` / `❌ Recusar` (os botões da oferta respondida são removidos);
3. no fim mostra o resumo com plano + bumps aceitos e o **total somado**, seguido dos links dos grupos VIP do plano.

```
🧾 Resumo do pedido
• plano ouro — R$ 149,90
• Ebook bônus — R$ 19,90
• Mentoria 1h — R$ 97,00

💰 Total: R$ 266,80

🔗 Seus grupos VIP:
• Sala VIP: https://t.me/+AbCdEf123
```

Cada link é único: 1 uso e 1 hora de validade (`createChatInviteLink`). Grupo em que o bot não é admin aparece com aviso de erro em vez do link.

O carrinho vai no `callback_data` (`bump:<planId>:<idx>:<bitmask>:<0|1>`) — sem sessão em memória, por isso o limite de 31 bumps. Checkout/pagamento e entrega dos `deliverables` ainda não implementados.
