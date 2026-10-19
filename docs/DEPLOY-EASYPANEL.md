# Correio: deploy no EasyPanel com um único zip

O Correio é o app de e-mail (PWA) das suas caixas no poste.io: **um arquivo zip, um serviço, uma variável obrigatória**. O próprio Correio gera e guarda as chaves internas (chave mestra, chaves de notificação e convite) na primeira subida.

Endereço final: `https://correio.judinfo.com.br`

---

## 1. Antes de começar

### 1.1 Gerar o zip

Na pasta `correio/` do repositório:

```
scripts/empacotar-easypanel.sh
```

Sai o arquivo `correio/dist/correio-easypanel.zip` (com o `Dockerfile` na raiz do zip).

### 1.2 Endereço do banco (`DATABASE_URL`)

O mesmo Postgres que os outros sistemas do projeto `funciona` usam, no formato:

```
postgres://USUARIO:SENHA@HOST_DO_POSTGRES:5432/BANCO
```

No EasyPanel, abra o serviço do Postgres → aba **Credenciais** → copie a **URL de conexão interna**. O Correio cria sozinho o schema `correio` e as tabelas (não mexe no schema `vigia` nem nos outros).

### 1.3 Chave do OpenRouter (`OPENROUTER_API_KEY`), opcional

Serve só para o **selo de possível phishing/spam** nas mensagens recebidas. Sem ela o Correio funciona normalmente, apenas sem o selo.

Pode usar a mesma chave do Vigia, ou criar outra em <https://openrouter.ai/keys> → **Create Key** → nome `correio`.

### 1.4 Onde o Correio encontra o poste.io

O poste.io roda no seu servidor de casa (`192.168.0.118`), **a mesma máquina do EasyPanel**, como o serviço **`poste_io`** do projeto **`funciona`**, **sem portas publicadas no host**. O Correio fica no projeto **`laboratorio`** e fala com ele **por dentro**, pela rede do EasyPanel, que liga os serviços de projetos diferentes pelo nome interno `<projeto>_<serviço>`:

- **`IMAP_HOST=funciona_poste_io`** e **`SMTP_HOST=funciona_poste_io`**;
- **`MAIL_TLS_VERIFY=false`**: o certificado do poste.io é emitido para `email.judinfo.com.br`, não para o nome interno. A conexão continua criptografada (TLS); só deixa de conferir o nome do certificado.

Portas: **993** (IMAP), **587** (SMTP) e **4190** (ManageSieve, filtros de encaminhamento e resposta automática). São os padrões, não precisa defini-las. Como o acesso é pela rede interna, nenhuma delas precisa ser publicada no host.

> Para confirmar que acertou: depois do deploy, ao adicionar a primeira caixa (passo 8), o Correio já testa a conexão. Se der erro, nos ajustes da caixa → **Conta** → **Testar conexão** a mensagem diz o motivo: `servidor não encontrado` (nome errado), `servidor recusou a conexão` (porta/nome), `certificado TLS do servidor não confere` (falta `MAIL_TLS_VERIFY=false`) ou `usuário ou senha recusados` (senha da caixa).
>
> **Se o nome interno não resolver** (`servidor não encontrado`), confira no EasyPanel o nome exato do serviço do poste.io (aba **Geral**, formato `<projeto>_<serviço>`). Usar o IP `192.168.0.118` **não** funciona nessa instalação, porque o poste.io não publica portas no host.

---

## 2. Criar o serviço

1. No EasyPanel, abra o projeto **`laboratorio`** → **+ Serviço** → **App** → nome **`correio`** → Criar.
2. Aba **Fonte (Source)** → escolha **Upload** → envie o arquivo **`correio-easypanel.zip`**.
3. Aba **Build** → tipo **Dockerfile** → caminho do arquivo: **`Dockerfile`** → Salvar.
4. **Réplicas: 1** (deixe sempre uma só). O Correio mantém dentro do próprio serviço a conexão que vigia a caixa de entrada (para avisar e-mail novo); duas cópias mandariam avisos repetidos e disputariam as mesmas chaves.

## 3. Variáveis de ambiente

Aba **Ambiente (Environment)** → cole e preencha:

```
DATABASE_URL=postgres://USUARIO:SENHA@HOST_DO_POSTGRES:5432/BANCO
OPENROUTER_API_KEY=<chave do passo 1.3, ou apague esta linha>
IMAP_HOST=funciona_poste_io
SMTP_HOST=funciona_poste_io
MAIL_TLS_VERIFY=false
```

`SIEVE_HOST` não precisa ser definido: o padrão é o `IMAP_HOST` (`funciona_poste_io`), porta 4190.

Opcionais (normalmente não precisa):

| Variável | Padrão | Para que serve |
|---|---|---|
| `SMTP_HOST` | igual ao `IMAP_HOST` | Servidor de envio, se for outro. |
| `IMAP_PORT` / `SMTP_PORT` | `993` / `587` | Portas do poste.io. |
| `SIEVE_HOST` | igual ao `IMAP_HOST` (`funciona_poste_io`) | Servidor ManageSieve (encaminhamento e resposta automática). |
| `SIEVE_PORT` | `4190` | Porta do ManageSieve do poste.io (usa STARTTLS e respeita `MAIL_TLS_VERIFY`). |
| `CORREIO_HOST` | `correio.judinfo.com.br` | Endereço onde você abre o Correio. Veja o aviso abaixo. |
| `VAPID_SUBJECT` | `mailto:djair@djairrotta.com.br` | Contato enviado aos serviços de push. |

> **Atenção com `CORREIO_HOST`:** o login com Face ID só funciona no endereço exato definido aqui. **Não** coloque `judinfo.com.br`, `email.judinfo.com.br` nem outro endereço: tem de ser exatamente o que você digita no Safari. Foi isso que quebrou o Face ID do Vigia. **Na dúvida, não defina** — o padrão já é `correio.judinfo.com.br`.

> **Não use `MAIL_SECURE=false`.** Essa variável existe só para testes: desliga o TLS e as senhas das caixas trafegariam em texto puro. Se aparecer `ATENÇÃO: MAIL_SECURE=false` no log, remova-a.

### 3.1 Envio por domínio via Resend (opcional)

Por padrão, **todo envio sai pelo poste.io**. Se você tem uma ou mais contas na [Resend](https://resend.com), pode fazer o Correio enviar pela Resend quando o remetente for de um domínio **verificado naquela conta** — útil para entregabilidade. **O recebimento (IMAP) continua sempre pelo poste.io**; a Resend só entra no envio (SMTP).

**As chaves da Resend ficam SÓ em variáveis de ambiente — nunca no banco.** Defina de 1 a 20 variáveis, uma por conta (slot), só com a chave:

```
RESEND_CONTA_1=re_SuaChave1
RESEND_CONTA_1_NOME=Conta principal      # opcional: rótulo do slot
RESEND_CONTA_2=re_SuaChave2
```

- A chave tem de começar com `re_` e **tem de ser da conta Resend onde os domínios estão verificados** — uma chave de outra conta não envia por esses domínios.
- `RESEND_CONTA_<n>_NOME` (opcional) dá um nome ao slot. `RESEND_FROM_PADRAO` (opcional) é o nome de exibição padrão do remetente quando a caixa não tem um.
- Envio por Resend usa `smtp.resend.com:587` com STARTTLS, usuário `resend` e a chave como senha. A chave **nunca** aparece no log nem na interface (só a máscara, ex.: `re_Su…ve1`).

**Os domínios de cada conta você gerencia no app**, em **Ajustes → Diagnóstico → Contas Resend**: a tela lista os 20 slots, mostra quais têm chave no servidor (pela máscara) e o nome do slot, e deixa você **atribuir/mover domínios a um slot, renomear o slot e testar a chave** (`verify()` no SMTP da Resend, sem revelar a chave). Um domínio só pode estar em **um** slot ativo; atribuir um domínio a um slot **sem chave no ambiente** é recusado com mensagem clara. A tela avisa quando o domínio de uma caixa não está mapeado (ou está num slot sem chave): essas caixas saem pelo poste.io.

> **Bootstrap:** se preferir já subir com os domínios preenchidos, use a forma `RESEND_CONTA_<n>=re_chave | dominio1,dominio2` — na **primeira subida** (quando ainda não há mapeamento no banco) o Correio semeia o mapa a partir desses domínios. Depois disso o mapeamento é só pelo app; mudar a lista inline não sobrescreve o que você ajustou.

**Precedência ao resolver o remetente:** primeiro o **mapeamento do app** (domínio→slot) usando a chave daquele slot no ambiente; se não houver mapa, os **domínios inline** declarados nas variáveis; por fim o **poste.io**.

Ao testar a conexão de uma caixa (passo 8, ou **Conta → Testar conexão**), o Correio também verifica o caminho de envio resolvido e informa por onde ela sai (poste.io ou `Resend conta 1 re_Su…ve1`).

**Não** precisa criar `CORREIO_MASTER_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `WEBAUTHN_*` nem `CORREIO_INVITE_CODE`: o Correio gera e guarda no volume (passo 4). Se quiser valores próprios, basta defini-los aqui: o que estiver no ambiente sempre vale mais.

Salve.

## 4. Volume de dados (obrigatório)

Aba **Montagens (Mounts)** → **Adicionar**:

- Tipo: **Volume** (não use **Bind**: uma pasta do servidor montada como Bind normalmente pertence ao root e o Correio, que roda sem privilégios, não consegue gravar nela)
- Nome: **`correio-dados`**
- Caminho de montagem: **`/data`**

Se o volume faltar ou não aceitar escrita, o serviço não sobe e o log mostra `Não consigo gravar em /data ...` com esta mesma instrução.

É aqui que fica o arquivo `correio-segredos.json` com as chaves geradas. **Não apague este volume**: sem ele a chave mestra muda, as senhas das caixas guardadas no banco ficam ilegíveis (será preciso digitá-las de novo) e o Face ID cadastrado precisa ser refeito. Faça backup dele junto com o banco.

## 5. Domínio

Aba **Domínios** → **Adicionar domínio**:

- Host: **`correio.judinfo.com.br`**
- Porta: **`8080`** (atenção: não é 80)
- HTTPS: como nos outros serviços.

Não precisa mexer no DNS nem no túnel: o curinga `*.judinfo.com.br` da Cloudflare já passa pelo túnel até o EasyPanel, e o EasyPanel entrega ao Correio pelo domínio cadastrado aqui.

> Nunca publique a porta 8080 diretamente no servidor (mapeamento de porta). O acesso deve passar sempre pela Cloudflare (com o Access do passo 7).

## 6. Implantar e pegar o link de primeiro acesso

1. Clique em **Implantar (Deploy)**. O primeiro build leva alguns minutos.
2. Abra a aba **Logs**. Procure o bloco:

   ```
   ========================================================================
   PRIMEIRO ACESSO: https://correio.judinfo.com.br/login?convite=xxxxxxxx
   Abra este link no iPhone (Safari) e cadastre o Face ID.
   ========================================================================
   ```

   Esse link aparece a cada subida **enquanto nenhum aparelho estiver cadastrado** (o convite é o mesmo em todas as subidas; fica guardado no volume). Copie-o.
3. Se aparecer `Variáveis de ambiente faltando`, volte ao passo 3.

### Verificação de saúde

- O EasyPanel/Docker usa `/api/vivo` para saber se o processo está de pé (não depende do banco, para não reiniciar o serviço à toa).
- Para monitoração externa (Uptime Kuma, etc.), use **`https://correio.judinfo.com.br/api/saude`**: responde `200` com o banco de pé e `503` com o motivo se o banco cair. Como fica atrás do Access, o monitor precisa de um token de serviço do Access (ou monitore pela rede interna).

## 7. Cloudflare Access (proteção antes do login)

Faça como no webmail:

1. Em <https://one.dash.cloudflare.com> → **Zero Trust → Access → Aplicativos**.
2. Abra o aplicativo que protege o webmail (ou crie um **Auto-hospedado**) → adicione o domínio **`correio.judinfo.com.br`**.
3. Política **Somente Djair** (regra: e-mail `djairrotta@outlook.com`) → Salvar.

Ao abrir o endereço, a Cloudflare pedirá o código por e-mail antes de mostrar o Correio. Depois disso ainda vem o Face ID do próprio Correio.

## 8. Primeiro acesso no iPhone

1. No iPhone, abra no **Safari** o link `PRIMEIRO ACESSO` do passo 6 (passe pelo código do Access).
2. Toque em **Cadastrar este dispositivo (Face ID)**.
3. Toque em Compartilhar → **Adicionar à Tela de Início**. Feche o Safari e abra o Correio **pelo ícone** (o iOS só envia notificações para apps instalados na Tela de Início).
4. **Adicionar as caixas:** em **Caixas → Adicionar caixa**, informe o endereço completo (ex.: `contato@djairrotta.com.br`) e a senha da caixa no poste.io → **Adicionar e testar**. Repita para cada caixa. Se o teste falhar, veja o quadro do passo 1.4.
5. **Marca de cada caixa:** abra a caixa → ajustes da caixa → **Marca**:
   - **Logo**: PNG, JPEG ou WebP, até 2 MB (SVG não é aceito). Aparece na lista e pode ir na assinatura.
   - **Favicon**: PNG, JPEG ou WebP, até 2 MB (ICO também é aceito).
   - **Usar cor do logo** define a cor da caixa a partir do logo.
6. **Assinatura:** na mesma tela, seção **Assinatura** → preencha nome, cargo, telefone, site → ligue **Incluir logo** se quiser → **Salvar assinatura**. A prévia mostra como fica.
7. **Notificações:** em **Ajustes → Notificações neste aparelho** → ative e permita. Em cada caixa, **Notificações desta caixa** escolhe o que avisar (recebido, enviado, falha).

## 9. Outro aparelho

- **Aparelho Apple com o mesmo Apple ID** (iPad, Mac, iPhone novo, com Chaves do iCloud ativadas): abra `https://correio.judinfo.com.br` e toque em **Entrar com passkey**, sem novo cadastro.
- **Aparelho fora do iCloud:** cadastre **a partir de um aparelho já logado**: nele abra `https://correio.judinfo.com.br/login?convite=novo` (com sessão ativa o servidor aceita o cadastro mesmo sem convite válido) e, no pedido de passkey, escolha **usar outro dispositivo / QR code** e leia o código com o aparelho novo. As passkeys cadastradas aparecem em **Ajustes → Passkeys**.
- Notificações são **por aparelho**: ative em **Ajustes** em cada um.

## 10. Atualizar o Correio

Gere um zip novo (`scripts/empacotar-easypanel.sh`), envie em **Fonte → Upload** e clique em **Implantar**. O volume `correio-dados` e o banco são mantidos.

## 11. Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Serviço reinicia com `Variáveis de ambiente faltando` | Falta o `DATABASE_URL` (passo 3). |
| `Não consigo gravar em /data` | Falta o volume ou ele foi criado como **Bind**. Refaça o passo 4 com o tipo **Volume**. |
| `correio-segredos.json está corrompido` | Restaure o backup do volume `correio-dados`. Não apague o arquivo sem necessidade. |
| Face ID falha / "O navegador recusou a passkey neste endereço" | O endereço aberto tem de ser exatamente `https://correio.judinfo.com.br`. Se você definiu `CORREIO_HOST`, apague-o (ou corrija) e implante de novo. |
| Link de primeiro acesso não aparece | Já existe aparelho cadastrado: o convite só vale enquanto **nenhuma** passkey existir. Veja o passo 9. |
| Perdi todos os aparelhos | No Console do Postgres: `DELETE FROM correio.passkeys;` e reinicie o serviço `correio`: o link `PRIMEIRO ACESSO` volta a aparecer no log (o código também está em `/data/correio-segredos.json`). |
| Caixa com `servidor não encontrado`, `servidor recusou a conexão` ou `tempo esgotado` | `IMAP_HOST`/`SMTP_HOST` errado ou inacessível. Confira o nome interno do poste.io (passo 1.4): `funciona_poste_io`. |
| Regras (encaminhar / resposta automática) dizem que o servidor de filtros não respondeu | O Correio não alcança o ManageSieve em `SIEVE_HOST:SIEVE_PORT` (padrão `funciona_poste_io:4190`). Confira o nome e se o Sieve está ligado no poste.io. |
| Caixa com `certificado TLS do servidor não confere` | Defina `MAIL_TLS_VERIFY=false` (passo 3). |
| Caixa pede senha de novo | A senha foi recusada pelo poste.io. Abra a caixa → ajustes → **Conta** → **Nova senha da caixa** → **Salvar e testar**. O Correio não tenta de novo uma senha recusada. |
| Selo de phishing não aparece | Falta `OPENROUTER_API_KEY` ou o classificador está desligado em **Ajustes → Classificador**. Se o OpenRouter falhar 3 vezes seguidas, o classificador pausa sozinho por 15 min (log `[classificador] 3 falhas seguidas; pausado por 15 min`); uma mensagem que falhou só é tentada de novo após 10 min. Os e-mails continuam chegando e sendo avisados normalmente. |
| Página não abre / erro 502 | Confira se o domínio está com a porta **8080**. |
| Sem notificação no iPhone | O app precisa estar na Tela de Início e aberto pelo ícone; ative em **Ajustes**. |
