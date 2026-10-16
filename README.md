# fisco-backend

API, ETL e motor de teses da plataforma de prospecção tributária
(`fisco.judinfo.com.br`, dentro do hub judinfo).

## O que roda aqui

| Parte | Arquivo | O que faz |
|---|---|---|
| ETL em massa | `src/etl/pgfn.ts` | Carrega a dívida ativa da PGFN (CSV trimestral) |
| Views | `src/etl/refresh-views.ts` | Materializa os agregados que o mapa lê |
| Motor de teses | `sql/005_score.sql` | Elegibilidade em SQL puro — **sem LLM** |
| Maturidade | `src/services/maturidade.ts` | Reconsulta semanal no Hermes |
| Preenchimento | `src/services/preenchimento.ts` | Campos em JSON via OpenRouter |
| Handoff | `src/services/nexus.ts` | Abre ordem de cálculo no NEXUS |

## Instalar

```bash
npm install
cp .env.example .env     # preencha DATABASE_URL e JWT_SECRET
npm run migrate          # cria schema, 54 partições, índices e views
npm run teses:load       # carrega as regras de tese
npm run dev
```

## Carga dos dados

```bash
# 1. base CNPJ da Receita (mensal) e PGFN (trimestral) — baixe os CSV
npm run etl:pgfn -- ./data/download/divida.csv PGFN_GERAL 2026-06-30
# 2. materializa os agregados (o painel nunca lê a tabela bruta)
npm run etl:refresh
```

## Três regras que não se negociam

1. **A IA devolve campos, o backend monta o .docx.** Se o modelo cuspir a peça
   inteira, a saída quintuplica de custo e ele ganha poder de alterar a
   fundamentação já validada.
2. **Só devedor principal** (`tipo_devedor = 1`) ao somar dívida. Corresponsável
   duplica — a própria PGFN avisa.
3. **Todo valor exibido carrega a data de referência da sua fonte.** A PGFN é
   trimestral; sem a data, o assinante liga para a empresa com número velho.

## Por que Haiku 5.5 com raciocínio desligado

Medido, não suposto: ver [docs/BENCHMARK.md](docs/BENCHMARK.md). 144 chamadas,
12 casos com 7 armadilhas. Configurável em `.env` — o backend obedece a
hierarquia, sem modelo cravado no código.

## Pendências assumidas

- O nome `fisco` é provisório. Renomear é `git mv` + variável de ambiente.
- As duas teses em `data/teses/` são exemplos — uma delas propositalmente
  **derrotada**, para provar que o score zera e ela some do mapa.
- A validação jurídica das 30 teses é trabalho humano e não está aqui.

## Documentos que explicam as decisões

- [`docs/BENCHMARK.md`](docs/BENCHMARK.md) — por que Haiku 5.5 com raciocínio desligado, medido em 144 chamadas
- [`docs/CONCORRENCIA.md`](docs/CONCORRENCIA.md) — o que o EmpresAqui tem, onde fica descoberto, e por que não vendemos disparo em massa

## Módulos novos

| Arquivo | O que faz |
|---|---|
| `sql/006_crm.sql` | CRM de leads: funil como dado, junção polimórfica, timeline com snapshot |
| `sql/007_processos.sql` | Processos, movimentos do DataJud, publicações do DJEN, monitores |
| `src/services/processos.ts` | iAndamento descobre pelo CNPJ, DataJud enriquece pelo número |
| `src/services/jev.ts` | Classificação determinística, sem LLM, com fallback local |
| `src/services/mensageria.ts` | Resend, poste.io e open-wa — só para o assinante, nunca disparo em massa |
