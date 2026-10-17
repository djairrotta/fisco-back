# Carga de dados

## PGFN — dívida ativa da União

Automática. O container baixa, transforma e carrega sozinho:

```bash
node dist/etl/pgfn.js 2026_trimestre_02 2026-06-30
node dist/etl/refresh-views.js
```

Sem a lista de bases ao final ele carrega as três. Para uma só:

```bash
node dist/etl/pgfn.js 2026_trimestre_02 2026-06-30 PGFN_FGTS
```

Medido no 2º tri/2026, carga completa:

| Base | zip | lidas | aceitas | rejeitadas | inscrições (principal) | valor |
|---|---|---|---|---|---|---|
| FGTS | 18 MB | 541.698 | 539.081 | 0,5% | 539.081 | R$ 70,9 bi |
| Previdenciário | 83 MB | 3.606.529 | 3.488.188 | 3,3% | 3.488.188 | R$ 477,6 bi |
| Não Previdenciário | 1,34 GB | 45.553.971 | 28.312.053 | 37,9% | 27.221.486 | R$ 2.774,7 bi |
| **Total** | | | | | **31.248.755** | **R$ 3.323,2 bi** |

**As rejeitadas são pessoa física, e isso foi CONFERIDO, não suposto.** Os
37,9% do Não Previdenciário assustam ao lado dos 0,5% do FGTS, então a
amostra de 6 milhões de linhas foi classificada motivo a motivo: 2.419.066
rejeições, 100% `Pessoa física`, nenhuma falha de parse. O mesmo exercício
no Previdenciário reproduziu exatamente o número que o ETL registrou
(118.341), o que valida o método.

Por isso o ETL agora grava `carga_etl.motivos_rejeicao`. Um contador único
torna "38% são pessoa física" indistinguível de "38% quebraram no parse", e
a diferença entre os dois é perder um terço do mercado sem perceber.

**Disco:** a carga do Não Previdenciário sozinha consumiu cerca de 18 GB de
staging, contra 4 GB das outras duas somadas. Tabela temporária mais
`DELETE` e `INSERT` duplicam o dado e ainda geram WAL. Tenha pelo menos
25 GB livres antes da janela trimestral.

### O que foi aprendido com o arquivo real

**As três bases não têm o mesmo cabeçalho.** Só o FGTS tem 15 colunas.
Previdenciário e Não Previdenciário (SIDA) têm 13, e chamam o tributo de
`TIPO_CREDITO` em vez de `RECEITA_PRINCIPAL`. Por isso o parse é feito pelo
cabeçalho de cada arquivo. Lendo por posição fixa, o Previdenciário
rejeitava 100% das linhas, e a base grande teria rejeitado as 45 milhões
dela também, em silêncio.

**`UF_DEVEDOR` tem valores fora das 27.** Aparece `SI` (1.531 linhas só no
FGTS). Existe partição `DEFAULT` para isso; sem ela o `INSERT` aborta a carga
inteira. As views filtram por `uf_valida()`, então `SI` nunca vira estado.

**`NOME_DEVEDOR` vem no arquivo.** O nome da empresa não depende da base da
Receita. A Receita é necessária só para município, CNAE, porte e regime.

**`DATA_INSCRICAO` usa `01/01/1000` como "não informado".** Qualquer ano
anterior a 1900 vira `NULL`, para não sujar o índice BRIN.

**Somar corresponsável dobra o valor.** Todo agregado filtra
`tipo_devedor = 1`, que é a regra da própria PGFN.

## Receita Federal — cadastro de CNPJ

Ainda não automatizada. É ela que destrava município, CNAE, porte e regime,
e portanto as 5.570 páginas de cidade. Enquanto não entrar, `mv_uf` já
funciona (vem direto da PGFN) e o recorte por município aparece como
indisponível, sem 404 e sem número inventado.

---

# Agendador

`AGENDADOR_ATIVO=true` liga um laço diário dentro do próprio backend. Roda
na hora de `AGENDADOR_HORA` (padrão 4h) e sobrevive a restart porque o
estado mora na tabela `fonte_dados`, não em memória.

```bash
node dist/etl/agendador.js      # uma passada avulsa, fora da janela
curl /api/fontes                # estado de cada fonte
```

## Por que não baixa todo dia

Porque a origem não muda todo dia. Conferido na fonte: a PGFN publica por
trimestre (`2026_trimestre_03` ainda devolve 404) e a Receita por mês.
Baixar 1,4 GB diários para reprocessar arquivo idêntico gasta banda, disco
e janela de manutenção sem mudar um número na tela.

O agendador então **roda todo dia e sonda todo dia**, com um `HEAD` que
custa milissegundos, e só **carrega quando a versão da origem muda**. Em
falha, recua em dobro: 1h, 2h, 4h, até o teto de 24h. Órgão público cai, e
insistir de minuto em minuto só garante bloqueio de IP.

**Ligue em uma réplica só.** Duas réplicas com o agendador ativo baixam
1,4 GB cada e brigam pelo mesmo `DELETE`/`INSERT`.

# Dívida estadual de SP e MG

**Não existe download em massa.** Conferido: a PGE-SP publica planilha
agregada de estoque (inscrições, recuperações, baixas), não lista de
devedor. Em Minas, a Resolução Conjunta SEF/AGE 5.625/2022 obriga publicar
a lista de devedores com nome, CNPJ, número de inscrição e valor, mas não
define formato de download.

Nos dois casos o acesso útil é **consulta por CNPJ**, que a Infosimples
expõe. Consequência de produto, e ela é importante:

- o **mapa agregado é federal**, porque só a PGFN entrega base inteira;
- o **estadual aparece na ficha da empresa**, sob demanda, com cache de
  30 dias, porque cada consulta custa e o dado muda devagar.

```
GET /api/empresas/:cnpj/divida-estadual/SP     (exige sessão)
```

Sem `INFOSIMPLES_TOKEN`, a resposta diz "não configurado" em vez de fingir
que a empresa não tem débito estadual. Ausência de dado não é ausência de
dívida.

# Receita Federal — cadastro de CNPJ

Mensal, em `dadosabertos.rfb.gov.br/CNPJ/dados_abertos_cnpj/{AAAA-MM}/`.
É ela que destrava município, CNAE, porte, regime, telefone e e-mail.

**Armadilha:** a coluna `MUNICIPIO` do arquivo **não é o código do IBGE**,
é código próprio da Receita. Como as páginas públicas e a `mv_municipio`
usam IBGE, o carregador monta a correspondência por UF + nome normalizado
contra a lista oficial do IBGE (5.571 municípios). Município que não casar
entra com `municipio_ibge` nulo, em vez de receber código errado.

**`RECEITA_AUTO` vem desligado de propósito.** O host da Receita recusa
conexão de fora do Brasil (TLS reset e 503), então esse download não pôde
ser testado fora do servidor. A transformação de linha e o mapa de IBGE
têm teste próprio e passam; o download em si precisa de uma primeira
execução manual no servidor antes de virar automático:

```bash
node dist/etl/receita-cnpj.js 2026-09
```

Conferido que funcionou, ligue `RECEITA_AUTO=true`.

# Contato das empresas, e um aviso

O arquivo da Receita traz telefone e e-mail do estabelecimento, e eles são
carregados. Antes de usá-los para disparo, vale lembrar do que já ficou
registrado em `src/services/mensageria.ts`: contato em massa com
prospecto, por e-mail ou WhatsApp, é captação de clientela pelo Código de
Ética da OAB e pelo Provimento 205/2021 do CFOAB. Por isso a mensageria
está limitada ao próprio assinante. O dado de contato serve para o
advogado ligar, um a um, com critério — que é diferente de disparar lista.

---

# Pessoa física

Entra na base desde a migração 015. Antes era descartada: 17,2 milhões de
linhas só no Não Previdenciário.

## A PGFN mascara o CPF

Esta é a informação que muda o produto, não o banco:

```
PJ:  10.496.760/0001-95     completo
PF:  XXX878.325XX           só os 6 dígitos do meio
```

Os 3 primeiros dígitos e os 2 verificadores são ocultados. O nome, não:
vem inteiro.

**O que dá para fazer:** buscar por nome, ver a dívida federal da pessoa,
o tributo, a data de inscrição e se já foi ajuizada.

**O que NÃO dá:**
- identificar a pessoa com certeza (6 dígitos mais nome não é chave única);
- enriquecer por CPF (APIBrasil e Infosimples exigem o CPF completo);
- deduplicar com segurança (no FGTS, `LINO MARTINS PINTO` aparece duas
  vezes com o mesmo fragmento: pode ser a mesma pessoa com duas
  inscrições, ou duas pessoas diferentes).

Por isso `documento` guarda o valor **publicado**, com as máscaras. Uma
coluna com `XXX878.325XX` ninguém confunde com CPF; uma com `878325`
alguém usaria como chave e erraria. `documento_completo = false` marca
essas linhas.

## PF não entra nos números de empresa

`mv_divida_empresa` filtra `tipo_pessoa = 'PJ'`. PF tem a sua própria,
`mv_divida_pessoa`, agrupada por fragmento + nome + UF, que é uma
aproximação, não uma contagem exata de pessoas.

`mv_uf` traz as duas lado a lado e **nunca somadas**:
`empresas_com_divida` / `divida_total` contra `pessoas_com_divida` /
`divida_pf`. Somar transformaria CPF em "empresa com dívida" no mapa, e o
número que o advogado usa para escolher onde prospectar ficaria falso.

Medido no 2º tri/2026 (FGTS + Previdenciário), SP: 256.285 empresas e
R$ 204,3 bi, contra 509 pessoas e R$ 24,8 mil. A ordem de grandeza mostra
por que a separação importa.

## TIPO_DEVEDOR tem três valores

Contagem do arquivo inteiro do Não Previdenciário:

```
PRINCIPAL        27.221.486
CORRESPONSAVEL    1.075.007
SOLIDARIO            15.560
```

O ETL mapeava `/principal/` para 1 e **todo o resto** para 2, então
solidário virava corresponsável. Para a regra de soma dá no mesmo, mas são
situações jurídicas diferentes e a distinção interessa justamente a quem
vai montar a defesa. Agora: 1 principal, 2 corresponsável, 3 solidário.
A regra de ouro continua `tipo_devedor = 1`.

**Não testado contra dados reais de solidário:** esses 15.560 registros só
existem na base Não Previdenciário, que não foi recarregada depois desta
correção.

## Proteção de dados

Dívida de pessoa física é dado pessoal de pessoa identificada. A PGFN
publica sob a lei de transparência, e por isso mesmo mascara o CPF. Indexar
e oferecer busca por nome é tratamento de dado pessoal, com base legal
própria e deveres próprios, diferente do que vale para CNPJ, que não é
dado pessoal. Vale uma decisão consciente antes de expor essa busca ao
assinante.

---

# Sócios, e o cruzamento com a dívida de pessoa física

## Como carregar

O comando roda **dentro do container do backend**, não na sua máquina. No
EasyPanel, abra o serviço `fiscoback` e use a aba **Terminal**:

```bash
# período no formato AAAA-MM; sem ele, o mais recente publicado
node dist/etl/receita-cnpj.js 2026-09 socios
node dist/etl/refresh-views.js
```

O terceiro argumento escolhe o que carregar:

| argumento | o que baixa | tamanho aproximado |
|---|---|---|
| `socios` | `Socios0..9.zip` | alguns GB |
| `estabelecimentos` | `Estabelecimentos0..9.zip` | dezenas de GB |
| `tudo` (padrão) | os dois | dezenas de GB |

**Comece por `socios`.** É a parte menor e é ela que destrava o
cruzamento. `estabelecimentos` é o que destrava município, CNAE, porte e
regime, e é bem mais pesado.

Para saber qual é o período mais recente sem baixar nada:

```bash
node -e "import('./dist/etl/receita-cnpj.js').then(m=>m.versaoDisponivelReceita().then(console.log))"
```

Depois da carga, confira:

```sql
SELECT tipo, count(*) FROM fisco.socio GROUP BY tipo;
SELECT count(*), count(*) FILTER (WHERE confianca='alta') FROM fisco.mv_socio_devedor;
```

## Por que o cruzamento funciona

PGFN e Receita mascaram o CPF **nas mesmas posições**: ocultam os 3
primeiros dígitos e os 2 verificadores, publicando os 6 do meio.

```
PGFN (dívida de PF):  XXX878.325XX  ->  878325
RFB  (sócio do CNPJ): ***059052**   ->  059052
```

Nenhuma das duas revela o CPF. Mas o recorte idêntico torna o fragmento
comparável, e fragmento + nome liga a dívida **pessoal** de alguém às
empresas de que ele é sócio.

`nome_chave()` normaliza o nome (sem acento, caixa alta, pontuação
colapsada), então "Reináldo Grizzo" e "REINALDO GRIZZO" casam.

## É indício, não identificação

6 dígitos é 1 em um milhão, e o nome reduz muito a colisão, mas não a
zera. Por isso:

- `candidatos` diz quantos sócios distintos batem com o mesmo
  fragmento + nome. **1 é o caso limpo; mais que 1 exige conferência.**
- `confianca` é `alta` quando `candidatos = 1`, e `conferir` nos demais.
- Toda resposta da API carrega o aviso, para o cliente não exibir isso
  como fato.

## Endpoints

```
GET /api/empresas/:cnpj/socios-devedores   sócios desta empresa com dívida pessoal
GET /api/pessoas/:documento/empresas       empresas em que a pessoa é sócia
GET /api/pessoas?nome=...&uf=SP            busca de devedor PF por nome
```

Todos exigem sessão.

## Não testado contra o arquivo real

O host da Receita recusa conexão de fora do Brasil, então o download não
pôde ser exercitado daqui. O que **foi** testado, com dado real da PGFN e
sócios sintéticos no formato publicado pela Receita: a normalização dos
dois formatos de máscara para o mesmo fragmento, o casamento por nome com
acento e caixa diferentes, a contagem de candidatos e os três endpoints.
A primeira execução no servidor é a que fecha a prova.
