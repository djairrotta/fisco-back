# Vigia: deploy no EasyPanel com um único zip (recomendado)

Este é o jeito mais simples de colocar o Vigia no ar: **um arquivo zip, um serviço, quatro variáveis**. O próprio Vigia gera e guarda as chaves internas (chave mestra, chaves de notificação e convite) na primeira subida.

Endereço final: `https://vigia.judinfo.com.br`

> O modo antigo, com dois serviços (`vigia-backend` + `vigia-pwa`), continua descrito em `docs/DEPLOY.md`, mas o recomendado é este.

---

## 1. Antes de começar: separe 4 informações

### 1.1 Token da Cloudflare (`CF_API_TOKEN`)

1. Entre em <https://dash.cloudflare.com> → clique no seu perfil (canto superior direito) → **Meu perfil** → **Tokens de API** → **Criar token** → **Criar token personalizado**.
2. Nome: `vigia`.
3. Permissões (uma linha para cada, exatamente assim):

   | Escopo | Recurso | Acesso |
   |---|---|---|
   | Conta (Account) | Account Filter Lists | Editar |
   | Conta (Account) | Account Analytics | Ler |
   | Zona (Zone) | Zone WAF | Editar |
   | Zona (Zone) | Analytics | Ler |
   | Zona (Zone) | Zone | Ler |

4. **Recursos da conta:** Incluir → sua conta.
5. **Recursos da zona:** Incluir → **Todas as zonas**.
6. Continue → **Criar token**. Copie o token (ele só aparece uma vez).

> Plano Free: cada zona aceita 1 lista e 5 regras personalizadas. O Vigia usa 1 lista e 2 regras (prefixo `vigia_`) e nunca mexe em regras que não criou.

### 1.2 ID da conta Cloudflare (`CF_ACCOUNT_ID`)

Na página inicial da Cloudflare, abra o menu de três pontos ao lado do nome da conta → **Copiar ID da conta**.

### 1.3 Chave do OpenRouter (`OPENROUTER_API_KEY`)

1. Entre em <https://openrouter.ai/keys> → **Create Key** → nome `vigia`.
2. Copie a chave (começa com `sk-or-`).
3. Deixe algum saldo na conta (as IAs são cobradas por uso, valores baixos).

### 1.4 Endereço do banco (`DATABASE_URL`)

O mesmo Postgres que os outros sistemas do projeto `funciona` usam, no formato:

```
postgres://USUARIO:SENHA@HOST_DO_POSTGRES:5432/BANCO
```

No EasyPanel, abra o serviço do Postgres → aba **Credenciais** → copie a **URL de conexão interna**. O Vigia cria sozinho o schema `vigia` e as tabelas.

---

## 2. Criar o serviço

1. No EasyPanel, abra o projeto **`funciona`** → **+ Serviço** → **App** → nome **`vigia`** → Criar.
2. Aba **Fonte (Source)** → escolha **Upload** → envie o arquivo **`vigia-easypanel.zip`**.
3. Aba **Build** → tipo **Dockerfile** → caminho do arquivo: **`Dockerfile`** → Salvar.
4. **Réplicas: 1** (deixe sempre uma só). O Vigia roda o monitor e o agendador dentro do próprio serviço; duas cópias disputariam o mesmo trabalho e as mesmas chaves.

## 3. Variáveis de ambiente

Aba **Ambiente (Environment)** → cole e preencha:

```
DATABASE_URL=postgres://USUARIO:SENHA@HOST_DO_POSTGRES:5432/BANCO
CF_API_TOKEN=<token do passo 1.1>
CF_ACCOUNT_ID=<ID do passo 1.2>
OPENROUTER_API_KEY=<chave do passo 1.3>
```

Opcionais (só se quiser):

| Variável | Para que serve |
|---|---|
| `OPENWA_URL`, `OPENWA_API_KEY`, `ADMIN_PHONE` | Avisos também por WhatsApp (número com DDI, ex.: `5519999999999`). |
| `VIGIA_HOST` | Só se o endereço **não** for `vigia.judinfo.com.br`. O login com Face ID usa este endereço. |
| `EASYPANEL_URL`, `EASYPANEL_TOKEN` | Monitor dos apps do EasyPanel (aba **Apps**). Veja o passo 3.1. |
| `SSH_HOST`, `SSH_USER`, `SSH_PORT` | SSH do Vigia ao próprio servidor (aba **Servidor**: SMART e comandos de leitura). Veja o passo 4.2. |

**Não** precisa criar `VIGIA_MASTER_KEY`, `VAPID_*`, `WEBAUTHN_*` nem `VIGIA_INVITE_CODE`: o Vigia gera e guarda no volume (passo 4). Se quiser usar valores próprios, basta defini-los aqui: o que estiver no ambiente sempre vale mais.

Salve.

### 3.1 Monitor dos apps do EasyPanel (opcional)

1. **Criar o token:** no EasyPanel (`https://painel.judinfo.com.br`), menu **Settings → API** → gere um token de API e copie.
2. **Colar no Vigia:** neste mesmo app do Vigia → aba **Environment** → acrescente:
   ```
   EASYPANEL_URL=https://painel.judinfo.com.br
   EASYPANEL_TOKEN=<token do item 1>
   ```
3. Clique em **Deploy**. Na partida o Vigia valida o token (`auth/getUser`): a aba **Apps** mostra "EasyPanel: ok", "token inválido" ou "não configurado". Em até 2 minutos aparece um card por app (status, CPU/memória, domínios, reinícios).

Sem essas duas variáveis o monitor fica desligado e a aba mostra "EasyPanel não configurado". O token dá acesso de leitura ao painel: o Vigia lê o env dos apps só para checar segredos expostos e nunca grava, registra ou envia os valores (detalhes em `docs/MCP.md` → Apps do EasyPanel).

## 4. Volume de dados (obrigatório)

Aba **Montagens (Mounts)** → **Adicionar**:

- Tipo: **Volume** (não use **Bind**: uma pasta do servidor montada como Bind normalmente pertence ao root e o Vigia, que roda sem privilégios, não consegue gravar nela)
- Nome: **`vigia-dados`**
- Caminho de montagem: **`/data`**

Se o volume faltar ou não aceitar escrita, o serviço não sobe e o log mostra `Não consigo gravar em /data ...` com esta mesma instrução.

É aqui que fica o arquivo `vigia-segredos.json` com as chaves geradas. **Não apague este volume**: sem ele, a chave mestra muda e os segredos salvos no banco ficam ilegíveis, e o Face ID cadastrado precisa ser refeito. Faça backup dele junto com o banco.

### 4.1 Tela Servidor (2.1): /proc e /sys do host — só leitura

Na mesma aba **Montagens (Mounts)**, adicione dois **Bind**:

| Caminho no servidor (host path) | Caminho de montagem | Para quê |
|---|---|---|
| `/proc` | `/host/proc` | CPU, memória, discos e rede do servidor |
| `/sys` | `/host/sys` | temperaturas e lista de discos |

O Vigia só **lê** esses caminhos (o processo roda sem privilégios). Sem eles a tela funciona pela metade: CPU, memória e discos ainda aparecem, mas a rede mostrada é a do container e as temperaturas podem faltar — a própria tela avisa.

### 4.2 SSH do Vigia ao servidor (SMART e comandos de leitura)

O container não acessa os discos, então o SMART e os comandos de diagnóstico (containers, logs, portas, conexões, journal, dmesg…) vão por SSH, **numa lista fechada e somente leitura**. Não existe terminal livre, nem pelo app nem pelo MCP. Tudo vai para a auditoria.

1. Suba o Vigia e abra **Servidor → SSH do Vigia**: ele mostra a linha pronta para o `authorized_keys` (a chave é gerada pelo próprio Vigia em `/data/ssh`; a privada nunca sai de lá). Pelo MCP: `servidor_chave_ssh`.
2. No servidor, como root:
   ```bash
   adduser --disabled-password --gecos '' vigia
   mkdir -p /home/vigia/.ssh && chmod 700 /home/vigia/.ssh
   nano /home/vigia/.ssh/authorized_keys      # cole a linha mostrada no Vigia
   chmod 600 /home/vigia/.ssh/authorized_keys && chown -R vigia:vigia /home/vigia/.ssh
   usermod -aG docker vigia                    # containers, docker stats e logs
   echo 'vigia ALL=(root) NOPASSWD: /usr/sbin/smartctl, /usr/bin/journalctl, /usr/bin/dmesg, /usr/bin/ss' > /etc/sudoers.d/vigia
   chmod 440 /etc/sudoers.d/vigia
   apt-get install -y smartmontools lm-sensors # se ainda não tiver
   ```
   A linha do `authorized_keys` já vem com `restrict` (sem shell interativo, túnel ou encaminhamento) e `from=` limitado às redes privadas.
   O grupo `docker` dá muito poder no servidor; se preferir, pule esse passo — só os comandos de containers deixam de funcionar.
3. Em **Environment** do Vigia: `SSH_HOST=<IP do servidor na rede local, ex.: 192.168.0.118>`, `SSH_USER=vigia` (e `SSH_PORT` se não for 22) → **Deploy**.

Comandos disponíveis: `uptime`, `memoria`, `espaco`, `discos`, `processos`, `processos_memoria`, `containers`, `containers_uso`, `container_logs`, `docker_espaco`, `journal`, `kernel`, `servicos_falhos`, `portas`, `conexoes`, `rede`, `logins`, `smart`, `sensores`, `atualizacoes`.

Ferramentas novas no MCP/API v1: `servidor_status`, `servidor_smart`, `servidor_chave_ssh`, `servidor_comandos`, `servidor_comando` (escopo escrever) e `servidor_teste_disco` (escopo escrever, 1 a cada 10 min).

Alertas por push (tipo **Servidor**, liga/desliga em Config): temperatura ≥ 85 °C, memória ≥ 92%, swap ≥ 60%, carga ≥ 1,5 por núcleo (diz se o gargalo é disco ou CPU), disco ≥ 95% ocupado e disco dos volumes ≥ 90% cheio — só depois de 2 leituras seguidas (4 min) e no máximo 1 aviso por problema a cada hora.

## 5. Domínio

Aba **Domínios** → **Adicionar domínio**:

- Host: **`vigia.judinfo.com.br`**
- Porta: **`8080`** (atenção: não é 80)
- HTTPS: como nos outros serviços.

> Nunca publique a porta 8080 diretamente no servidor (mapeamento de porta). O Vigia confia no cabeçalho `CF-Connecting-IP` da Cloudflare; com a porta exposta, ele pode ser forjado.

## 6. Implantar e pegar o link de primeiro acesso

1. Clique em **Implantar (Deploy)**. O primeiro build leva alguns minutos.
2. Abra a aba **Logs**. Procure o bloco:

   ```
   ========================================================================
   PRIMEIRO ACESSO: https://vigia.judinfo.com.br/login?convite=xxxxxxxx
   ========================================================================
   ```

   Esse link aparece a cada subida **enquanto nenhum aparelho estiver cadastrado**. Copie-o.
3. Confira também a linha `zonas: N na conta` (sinal de que o token da Cloudflare está certo). Se aparecer `Variáveis de ambiente faltando`, volte ao passo 3.

### Verificação de saúde

- O EasyPanel/Docker usa `/api/vivo` para saber se o processo está de pé (não depende do banco nem do ciclo, para não reiniciar o serviço à toa).
- Para monitoração externa (Uptime Kuma, etc.), use **`https://vigia.judinfo.com.br/api/saude`**: responde `503` com o motivo se o banco cair ou se o ciclo de monitoramento parar por mais de 5 minutos. Ele continua igual.

## 7. Cloudflare: túnel e Access

1. **Túnel/DNS:** em **Zero Trust → Redes → Tunnels**, no túnel que aponta para o EasyPanel, adicione o hostname público `vigia.judinfo.com.br` apontando para o mesmo destino dos outros subdomínios.
2. **Access:** **Zero Trust → Access → Aplicativos** → abra o aplicativo que protege o webmail (ou crie um **Auto-hospedado**) → adicione `vigia.judinfo.com.br` → política **Somente Djair** → Salvar.

Ao abrir o endereço, a Cloudflare pedirá o código por e-mail antes de mostrar o Vigia.

## 8. Cadastrar o iPhone

1. No iPhone, abra no **Safari** o link `PRIMEIRO ACESSO` do passo 6.
2. Toque em **Cadastrar este dispositivo (Face ID)**.
3. **Antes de ativar as notificações:** toque em Compartilhar → **Adicionar à Tela de Início**. Feche o Safari, abra o Vigia **pelo ícone** e só então ative as notificações (o iOS só envia push para apps instalados na Tela de Início).

## 9. Piloto de 24 horas

- Nas primeiras 24 h o Vigia fica em **modo observação**: detecta e avisa, mas **não bloqueia**.
- Acompanhe os incidentes e veja se há falsos positivos (seu IP, webhooks).
- Depois, em **Configurações**, ligue **Bloqueio automático** e **Bloquear fora do Brasil**.

## 10. Aviso de viagem

Com **Bloquear fora do Brasil** ligado, todo acesso de fora do Brasil é bloqueado, **exceto o próprio Vigia** (que continua protegido pelo Access e pelo Face ID).

No exterior, **ao chegar**, abra o Vigia → Configurações → **Modo viagem** e informe o prazo: ele libera o IP de onde você está. Trocou de rede (hotel → celular)? Ative de novo.

## 11. Atualizar o Vigia

Gere um zip novo (`scripts/empacotar-easypanel.sh`), envie em **Fonte → Upload** e clique em **Implantar**. O volume `vigia-dados` e o banco são mantidos.

## 12. Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Serviço reinicia com `Variáveis de ambiente faltando` | Falta uma das 4 variáveis do passo 3. |
| `Não consigo gravar em /data` | Falta o volume ou ele foi criado como **Bind**. Refaça o passo 4 com o tipo **Volume**. |
| `vigia-segredos.json está corrompido` | Restaure o backup do volume `vigia-dados`. Não apague o arquivo sem necessidade. |
| Link de primeiro acesso não aparece | Já existe aparelho cadastrado: o convite só vale enquanto **nenhuma** passkey existir. Veja "Outro aparelho" abaixo. |
| Outro aparelho (iPad, Mac, iPhone novo) | A passkey do Vigia fica nas **Senhas do iCloud**: em outro aparelho Apple com o **mesmo Apple ID** (Chaves do iCloud ativadas), abra o Vigia e toque em **Entrar com passkey**, sem novo cadastro. Para um aparelho fora do iCloud, cadastre **a partir de um aparelho já logado**: nele abra `https://vigia.judinfo.com.br/login?convite=novo` (com sessão ativa o servidor aceita o cadastro mesmo sem convite válido) e, no pedido de passkey, escolha **usar outro dispositivo / QR code** e leia o código com o aparelho novo. |
| Perdi todos os aparelhos | No Console do Postgres: `DELETE FROM vigia.passkeys;` e reinicie o serviço `vigia`: o link `PRIMEIRO ACESSO` volta a aparecer no log (o código também está em `/data/vigia-segredos.json`). |
| Página não abre / erro 502 | Confira se o domínio está com a porta **8080**. |
| Face ID falha | O endereço aberto tem de ser exatamente `https://vigia.judinfo.com.br` (ou o `VIGIA_HOST` definido). |
| Aviso "Coletor parado" | Token da Cloudflare expirado ou sem permissão (passo 1.1). |
| Sem notificação no iPhone | O app precisa estar na Tela de Início e aberto pelo ícone. |
| Aba Apps: "token inválido" / "EasyPanel recusou o token" | Token apagado ou errado: gere outro em **Settings → API** e atualize `EASYPANEL_TOKEN` (passo 3.1). |
| Aba Apps: "EasyPanel sem resposta" / "nenhum procedimento de listagem respondeu" | Confira `EASYPANEL_URL` (sem `/api` no fim). O Vigia usa `POST /api/rpc/…` (oRPC) e, em versões antigas, `GET /api/trpc/…`. Se o painel estiver atrás do Cloudflare Access, libere o acesso do Vigia (IP do servidor ou service token). Depois de atualizar o EasyPanel, nomes de procedimento podem mudar: veja `backend/src/easypanel/procedimentos.ts`. |
