# Bot do Telegram — plano para replicar em outro gateway

Atualizado em 2026-10-05

## 1. Visão geral

Para replicar, são três peças. Só a integração com o gateway PIX e a forma de achar a empresa e o token do gateway mudam de um gateway para outro; o resto é cópia.

| Peça | Onde está hoje | O que faz | Muda no gateway novo? |
| --- | --- | --- | --- |
| API multi-bot | `/root/telegram-boot/bot.js` (Node + Telegraf + SQLite embutido do Node), serviço systemd `telegram-boot`, porta 3454, público em `bot.bluevisionsolucoes.com.br` | Guarda os bots, roda um bot do Telegram por token, vende planos e cobra via PIX | Só `GATEWAY_URL` e o formato da cobrança (seção 3) |
| Rotas do painel | `dashboard-v2-nextjs-sub/src/app/api/bots/` (Next.js) | Proxy autenticado: descobre o CPF/CNPJ da empresa e o token do gateway no servidor e repassa para a API | Sim: como achar empresa e token (seção 4) |
| Tela (wizard) | `src/app/componentes/bots/BotWizardForm.tsx` + editores, páginas `/bot`, `/bot/novo`, `/bot/[id]/editar` | Cadastro em 7 passos | Não, só cores e componentes de UI |

Fluxo de uma venda: o cliente dá /start, vê a mensagem de boas-vindas e clica em "Acessar agora". Escolhe um plano, aceita ou recusa os order bumps, recebe o PIX (QR + copia e cola) e paga. O bot confirma no gateway e manda um link de convite de uso único para cada grupo VIP do plano.

## 2. API do bot (telegram-boot)

Um único processo Node roda todos os bots: cada linha da tabela `bots` vira uma instância do Telegraf com polling. Bot novo ou alterado entra no ar sem restart.

**Banco (SQLite, `bots.db`)**

| Tabela | Colunas principais | Para quê |
| --- | --- | --- |
| `bots` | id, name, token (UNIQUE), start_message, start_image, gateway_token, gateway_document, cnpj, downsell (JSON) | Config do bot; o token é a identidade |
| `plans` | id, bot_id, name, price, data (JSON do plano inteiro) | Planos |
| `order_bumps` | id, bot_id, name, price, data (JSON) | Ofertas extras, na ordem do id |
| `transactions` | id (id do gateway), bot_id, chat_id, plan_id, total, status, created_at | Cobranças PIX geradas |
| `purchases` | id, bot_id, chat_id, plan_id, total, created_at | Compras confirmadas (usado pelo downsell "só quem não comprou") |
| `scheduled_messages` | bot_id, chat_id, msg_index, send_at, sent_at, canceled; UNIQUE(bot_id, chat_id, msg_index) | Fila do downsell, sobrevive a restart |

**Endpoints**

| Método e rota | Faz |
| --- | --- |
| `POST /bots` | Cria ou atualiza (upsert pelo token). Só `name` e `token` são obrigatórios. Planos e bumps enviados **substituem** os antigos (apaga e regrava). Responde 201 (novo) ou 200 (atualizado) e já sobe o bot |
| `GET /bots` | Lista todos (formato público, sem token e sem `gateway_token`) |
| `GET /bots/cnpj/:cnpj` | Bots de uma empresa |
| `GET /bots/:id?cnpj=` | Bot completo para edição (com token). Se o cnpj não bater, responde 404 para não vazar ids |

**Validações do POST:** start_image tem que ser URL http(s); gateway_document e cnpj são 11 ou 14 dígitos; cada plano precisa de name e price numérico; cada grupo VIP precisa de idGroup; no máximo 31 order bumps (o carrinho vai num bitmask no callback do botão); downsell ligado precisa de ao menos uma mensagem, `trigger` em start ou abandoned_checkout, `audience` em new ou all, `button_mode` em plans_discount ou custom, `delay_minutes` ≥ 0 e `discount_percent` entre 0 e 100.

**Sincronização:** a cada 15 s (`SYNC_TICK_MS`) o processo compara o banco com o que está rodando. Bot novo sobe, token trocado religa a instância, e o resto da config é atualizado em memória. Bot que cai religa com espera crescente: 5 s, 10 s, 20 s, até 5 min.

**Comandos e eventos do bot no Telegram**

| Gatilho | Resposta |
| --- | --- |
| `/start` | Boas-vindas (foto ou vídeo opcional, legenda até 1024 caracteres) + botão "Acessar agora"; agenda o downsell de gatilho start |
| "Acessar agora" ou `/planos` | Lista de planos, um botão por plano |
| Clique no plano | Oferece cada order bump (Adicionar/Recusar), mostra o resumo e gera o PIX |
| "Verificar pagamento" | Consulta o gateway; se pago, entrega os links |
| `/groupid` em grupo | Responde "ID deste grupo: -100…" em `<code>` (no privado, explica que tem de ser no grupo) |
| Bot vira administrador de grupo ou canal (`my_chat_member`) | Manda o ID sozinho. Em canal é o único caminho, porque canal não entrega comandos |

**Entrega:** para cada grupo VIP do plano, `createChatInviteLink` com `member_limit: 1` e validade de 1 h. O bot precisa ser admin com a permissão "Convidar usuários via link". Se o grupo virou supergrupo, o bot usa o id novo que vem no erro do Telegram.

**Desligamento:** com SIGINT ou SIGTERM o processo para os bots e chama `process.exit(0)`. Sem isso o servidor HTTP segura o processo vivo.

## 3. Integração com o gateway PIX

É a única parte do bot que muda de verdade. Hoje são duas chamadas, as duas pela função `gatewayFetch` de `bot.js`, com a base em `GATEWAY_URL`. O padrão atual é `https://api.bluevisionsolucoes.com.br/functions/v1` (Supabase Edge Functions).

| Chamada | Envia | Espera de volta |
| --- | --- | --- |
| `POST /transactions` | Header `authorization: <gateway_token do bot>` (ex.: `Basic c2tf…`) e corpo `{ customer: { document: { number }, name, email, phone }, paymentMethod: "PIX", items: [{ title, unitPrice, quantity: 1 }], amount, installments: 1 }`, com valores em **centavos** | `{ id, status, pix: { qrcode } }`, onde `qrcode` é o copia e cola |
| `GET /transaction-status/:id` | O mesmo header | `{ success: true, data: { status } }`; conta como pago quando o status é `paid` ou `approved` |

Detalhes que o gateway novo precisa aceitar ou que você vai adaptar:

- **Dados do comprador:** o Telegram não dá CPF, e-mail nem telefone. O bot manda o nome do Telegram, `<id>@telegram.bot`, `11999999999` e o documento do cadastro do bot (`gateway_document`). Se não houver, gera um CPF válido aleatório. Gateway com KYC rígido pode recusar isso.
- **Erro:** resposta não-2xx ou `success: false` vira erro com `error` ou `message`, e o cliente vê "Não consegui gerar o PIX agora".
- **Confirmação:** depois de gerar o PIX o bot consulta o status a cada 5 s durante 1 min (`AUTO_CHECK_MS`, `AUTO_CHECK_TOTAL_MS`). Depois disso vale o botão "Verificar pagamento". Não há webhook (postback); se o gateway novo tiver, é o upgrade natural.
- **QR:** a imagem vem de `api.qrserver.com` a partir do copia e cola. Se falhar, o texto paga do mesmo jeito.
- **Sem gateway:** bot sem `gateway_token` entrega o acesso na hora, sem cobrar.

Para trocar de gateway: mude `GATEWAY_URL`, ajuste `pixPayload()` ao corpo que o gateway novo pede e ajuste a leitura de `tx.id`, `tx.pix.qrcode` e `r.data.status` em `gerarPix` e `consultarStatus`. O teste `test-gateway.js` sobe um gateway falso; atualize as respostas dele para o formato novo.

## 4. Rotas do painel (Next.js)

A tela nunca fala direto com a API do bot. Ela chama rotas do próprio painel, e essas rotas acrescentam no servidor o que o navegador não pode decidir: de qual empresa é o bot e com qual token ele cobra. A base da API vem de `NEXT_PUBLIC_BOT_API`.

| Rota do painel | Chama na API do bot | O que acrescenta |
| --- | --- | --- |
| `GET /api/bots` | `GET /bots/cnpj/:cnpj` | O cnpj da empresa logada; 404 vira lista vazia |
| `GET /api/bots/[id]` | `GET /bots/:id?cnpj=` | O cnpj, para só abrir bot da própria empresa |
| `POST /api/bots` (criar e editar) | `POST /bots` | `cnpj`, `gateway_token`, `gateway_document`; exige só nome e token |

Helpers em `src/lib/botApi.ts`, que são a parte a reescrever no gateway novo:

- **`resolveCompanyDocument(req)`**: lê os cookies `access_token`, `user_id` e `company_id`. Busca `GET {HOSTAPI}companies/:id` e usa o `taxid`; se não houver, busca `GET {HOSTAPI}users/:id` e usa o `document`. Devolve só dígitos (11 ou 14).
- **`resolveGatewayToken(req)`**: busca `GET {HOSTAPI}users/:id/apikey`, pega `api_secret_key` e monta `Basic base64("<secret>:x")`. É esse valor que vai como header `authorization` em cada cobrança do bot.
- **`generateRandomCpf()`**: CPF válido aleatório usado como `gateway_document`. Hoje é gerado de novo a cada salvar.

No gateway novo, troque as três fontes (cookie, endpoint da empresa, endpoint da chave) pelas equivalentes de lá, mantendo a regra: cnpj e token do gateway sempre resolvidos no servidor, nunca vindos do navegador.

## 5. A tela

São três páginas e um único formulário em passos, usado tanto para criar quanto para editar.

| Página | Conteúdo |
| --- | --- |
| `/bot` | Título "Bots do Telegram", subtítulo "Configure bots para vender seus planos direto no Telegram", botão "Novo bot" e um card por bot (`BotCard`: imagem, nome, início da mensagem, link para editar). Lista vazia mostra um convite para criar |
| `/bot/novo` | `<BotWizardForm mode="create" />` |
| `/bot/[id]/editar` | Carrega com `GET /api/bots/[id]` (esqueleto de carregamento, tela de erro com "Voltar para a listagem") e abre `<BotWizardForm mode="edit" initialBot={bot} />` |

**Estrutura do wizard:** cabeçalho com botão de voltar e título ("Criar bot do Telegram" ou "Editar bot do Telegram"). Abaixo, o trilho de passos (`StepRail`): círculos com ícone, viram check quando concluídos, e só dá para clicar em passos já alcançados. Depois o card do passo atual e o rodapé com Voltar, Salvar e Avançar. A cor de destaque vem da personalização da empresa (padrão `#9025EF`).

| # | Passo (rótulo · dica) | Campos | Para avançar |
| --- | --- | --- | --- |
| 1 | Token do bot · Credenciais | Nome do bot ("Ex: Bot Curso de Marketing"); Token do Telegram, campo senha com olho para mostrar | Nome e token preenchidos. O botão é **"Salvar e avançar"**: salva antes de seguir |
| 2 | Grupo VIP · ID do grupo | Tutorial numerado (abaixo) + Grupo VIP a liberar: Nome ("Sala VIP") e ID do grupo ("-1004436216602") | Nada obrigatório |
| 3 | Mensagem inicial · Boas-vindas | Mensagem (textarea, 7 linhas); imagem ou vídeo (upload para S3: PNG/JPG até 5 MB, MP4/MOV/WEBM até 20 MB) | Mensagem preenchida |
| 4 | Planos · Ofertas | Um card por plano (abaixo) + "Adicionar plano" | Ao menos 1 plano, todos com nome e preço > 0 |
| 5 | Order bumps · Opcional | Lista com Nome, Preço (R$) e Descrição opcional; vazio mostra "Nenhum order bump configurado ainda" | Nada |
| 6 | Downsell · Opcional | Chave "Ativar downsell automático"; ligada mostra Gatilho, Público, Botões e a sequência de mensagens | Ligado: ao menos 1 mensagem, todas com texto e atraso válido |
| 7 | Revisão · Publicar | Card com imagem, nome e mensagem; um card por plano (preço, duração, nº de grupos); contagem de bumps e estado do downsell | Botão final "Criar bot" ou "Salvar alterações" |

**Tutorial do passo 2**, em círculos numerados na cor de destaque:

1. No Telegram, abra o seu grupo ou canal privado e toque em Adicionar membros. Procure pelo seu bot e adicione.
2. Torne o bot administrador do grupo, com a permissão Convidar usuários via link ligada. Sem ela o bot não consegue gerar o link de acesso para quem comprar.
3. Assim que vira administrador, o bot manda no grupo uma mensagem com o ID. Se ela não aparecer, envie /groupid no grupo.
4. Copie o ID (começa com -100) e cole abaixo.

**Card de plano (`PlanEditorCard`):**

- Nome do plano ("Ex: Plano ouro"), Preço (R$) com máscara.
- Duração: Vitalício, Mensal ou Anual.
- Cor do botão: Padrão, Verde, Azul, Vermelho ou Roxo.
- Chave "Exibir order bump": mostra os bumps ao escolher este plano.
- Conteúdos entregues: lista de Título ("Senha do curso") e Conteúdo.
- Grupos VIP: lista de Nome e ID do grupo.
- Botão de remover, que some quando só há um plano.

**Downsell (`DownsellEditor`):**

- Gatilho: "Ao iniciar o bot" (`start`) ou "Checkout abandonado" (`abandoned_checkout`, quando o PIX é gerado e não pago).
- Público: "Apenas novos" (`new`) ou "Todos" (`all`).
- Botões: "Planos com desconto" (`plans_discount`) ou "Personalizado" (`custom`).
- Cada mensagem tem Atraso (minutos), Desconto (%), Texto da mensagem e Imagem ou vídeo opcional.

Dois campos são salvos mas o bot ainda não usa: a cor do botão e os conteúdos entregues. O modo de botões Personalizado também não envia botão nenhum. Se for replicar igualzinho, replique essas lacunas ou implemente os três.

## 6. Regras de salvar

O bot é salvo já no passo 1, para estar online quando a pessoa segue o tutorial do passo 2. Criar e editar usam a mesma chamada (`POST /api/bots`), e a API decide pelo token se cria ou atualiza.

| Ação | Quando aparece | Exige | Depois |
| --- | --- | --- | --- |
| Salvar e avançar | Passo 1 | Nome e token | Toast "Bot salvo!" e vai para o passo 2 |
| Salvar | Passos 2 a 6 | Nome e token; plano começado tem de estar completo; downsell ligado tem de ser válido | Toast e fica no mesmo passo |
| Criar bot / Salvar alterações | Passo 7 | Também mensagem de boas-vindas e ao menos 1 plano | Toast de sucesso e volta para `/bot` |

O que vai no payload a cada salvamento:

- **Estado completo:** o formulário inteiro vai sempre, porque a API substitui planos e bumps.
- **Planos:** plano em branco (sem nome e sem preço, como o card vazio inicial) fica de fora.
- **Grupos VIP:** linha de grupo sem ID sai do plano. Plano sem grupo próprio herda o grupo padrão do passo 2.
- **Downsell:** só vai quando está ligado.

**Grupo padrão do passo 2 contra grupo por plano:**

- Na edição, o campo do passo 2 só vem preenchido quando todos os planos que têm grupo usam exatamente o mesmo (um grupo, mesmo ID e nome). Se cada plano tem o seu, o campo fica vazio e os grupos aparecem só no passo Planos.
- Mudar o grupo padrão atualiza os planos que usavam o padrão anterior. Plano com grupo próprio não é tocado.
- "Adicionar plano" cria o plano novo já com o grupo padrão.

**Cuidado:** o token é a identidade do bot. Salvar no passo 1 e depois trocar o token cria um segundo bot em vez de atualizar o primeiro.

## 7. Tipos de dados

Copie `src/types/bot.ts` como está: é o contrato entre a tela, as rotas do painel e a API do bot.

```ts
type PlanDuration = "lifetime" | "monthly" | "yearly";
type TelegramButtonColor = "default" | "green" | "blue" | "red" | "purple";

interface BotVipGroup { idGroup: string; name: string }
interface BotDeliverable { title: string; content: string }

interface BotPlan {
  name: string;
  price: number;                      // em reais (a API converte para centavos na cobrança)
  duration: PlanDuration;
  telegram_button_color: TelegramButtonColor;
  deliverables: BotDeliverable[];
  vip_groups: BotVipGroup[];
  order_bump: { enabled: boolean };
}

interface BotOrderBump { name: string; price: number; description?: string }

interface DownsellMessage {
  delay_minutes: number;
  discount_percent: number;           // 0 a 100, só sobre o plano
  text: string;                       // até 4096 caracteres
  image?: string;                     // URL de foto ou vídeo
}

interface BotDownsell {
  enabled: boolean;
  trigger: "start" | "abandoned_checkout";
  audience: "new" | "all";
  button_mode: "plans_discount" | "custom";
  messages: DownsellMessage[];
}

// O que a tela envia; cnpj, gateway_token e gateway_document são postos pelo servidor
interface CreateBotPayload {
  name: string;
  token: string;
  start_message?: string;
  start_image?: string;               // URL; vídeo é detectado pela extensão .mp4 .mov .m4v .webm
  plans: BotPlan[];
  order_bumps: BotOrderBump[];        // máximo 31
  downsell?: BotDownsell;
}
```

## 8. Plano de implementação

A ordem segue a dependência: a tela precisa das rotas, as rotas precisam da API, e a API precisa do gateway.

1. **Gateway:** pegar a documentação do gateway novo. Confirmar a rota de criar cobrança PIX, a de consultar status, o formato do header de autenticação e os status de "pago".
2. **API do bot:**
   1. Copiar a pasta `telegram-boot` sem `bots.db`. Rodar `npm i` (Node 22 ou mais novo, por causa do `node:sqlite`).
   2. Apontar `GATEWAY_URL` e adaptar `pixPayload`, `gerarPix` e `consultarStatus` (seção 3).
   3. Ajustar `test-gateway.js` ao formato novo e rodar os 4 testes `test-*.js`.
   4. Subir como serviço (systemd com `Restart=always`, ou PM2) numa porta própria, com nginx e HTTPS num subdomínio.
3. **Rotas do painel:** copiar `src/lib/botApi.ts`, `src/app/api/bots/route.ts` e `src/app/api/bots/[id]/route.ts`. Reescrever `resolveCompanyDocument` e `resolveGatewayToken` para o login e a chave de API do gateway novo (seção 4) e configurar `NEXT_PUBLIC_BOT_API`.
4. **Tela:**
   1. Copiar `src/types/bot.ts`, `src/servicos/botsService.ts`, a pasta `src/app/componentes/bots/` (7 componentes) e as páginas em `src/app/(seller)/bot/`.
   2. Trocar as dependências de UI se o painel novo não tiver as mesmas: `@/components/ui` (input, label, textarea, select, switch), `lucide-react`, `react-toastify`, a cor vinda do Redux e o `uploadToS3`.
5. **Menu:** adicionar o item "Bots" apontando para `/bot`.

**Checklist de testes no ar**

- [ ] Passo 1 com nome e token: o bot aparece na API e responde /start no Telegram
- [ ] Bot virou admin no grupo: manda o ID sozinho; /groupid no grupo também responde
- [ ] Salvar no meio do wizard com um plano em branco: salva sem erro
- [ ] Publicar sem mensagem ou sem plano: mostra o aviso e não salva
- [ ] Editar um bot: todos os campos voltam preenchidos, inclusive o grupo padrão
- [ ] Compra com order bump: o resumo soma certo e o PIX sai em centavos certos
- [ ] Pagar o PIX: em até 1 min o bot confirma sozinho e manda o link de convite de uso único
- [ ] "Verificar pagamento" depois de pago: reenvia os links sem registrar compra duplicada
- [ ] Downsell de checkout abandonado: chega no atraso configurado e para depois da compra
- [ ] Empresa A não enxerga nem abre bot da empresa B (`GET /api/bots/[id]` responde 404)
