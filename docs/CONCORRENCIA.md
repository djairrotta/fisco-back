# EmpresAqui: o que eles têm, onde ficam descobertos

Levantamento por leitura das páginas públicas, do `openapi.json` e de um CSV
de exportação real deles.

## O que eles fazem bem, e vale copiar

**Taxonomia em linguagem de leigo.** Cerca de 200 rótulos ("Esmalterias",
"Energia solar") mapeados sobre CNAE. Remove o atrito de conhecer código CNAE.

**Variação trimestral da dívida.** Transformam o snapshot da PGFN em série
temporal com percentual de variação. É o melhor insight de produto que eles
têm, e é derivado, não copiado. **Devemos fazer igual**: já guardamos
`data_referencia` por carga, então a série sai de graça.

**SEO industrial.** Página indexada por UF, cidade, bairro, segmento e uma
por empresa, com paywall parcial. É o ativo mais difícil de copiar rápido, e é
exatamente o que as 5.597 páginas do `fisco-web` atacam.

**Loop ICP → semelhantes.** Um clique recarrega a busca com os parâmetros
daquela empresa. Gera recorrência de uso real.

## Onde eles estão descobertos

| Lacuna deles | Nossa resposta |
|---|---|
| Dívida só federal | PGFN + lista de devedores (inclui dívida estadual de SP pelo acordo com a PGE) + SEF/AGE-MG |
| Campos de dívida existem mas **não são filtráveis** — só exibidos | Filtro por tributo e por data de inscrição já é superioridade imediata |
| "Em Recuperação Judicial" é **match de string na razão social** (admitido por eles no próprio blog) | Dado processual real pelo iAndamento e DataJud |
| Zero monitoramento: produto 100% pull | Monitor por CNPJ, CPF e OAB com alerta por e-mail, WhatsApp e push |
| API só consulta por CNPJ, 1 req/s, sem busca, sem webhook | API de busca com filtros, paginação e webhook de evento |
| "Um estado por vez" nos planos baixos | Busca nacional no plano de R$ 49 |
| Nenhuma camada de tese | Motor de teses com maturidade jurisprudencial reconsultada toda semana |
| Nenhum cálculo | Agente de cálculo tributário no NEXUS |
| Exportação mais pobre que a tela | Paridade total de campos |

## O ponto que decide o posicionamento

**Eles vendem disparo em massa de e-mail e WhatsApp para prospecção, e
publicam conteúdo recomendando isso a advogados.**

Para advogado, isso é captação de clientela. O Código de Ética da OAB e o
Provimento 205/2021 do CFOAB vedam oferta de serviço a destinatário
indeterminado e admitem só publicidade informativa. O escritório que usar a
ferramenta deles como anunciada se expõe a representação disciplinar.

Nós temos as mesmas peças técnicas — Resend, poste.io, open-wa — e **a decisão
é não vender isso**. O módulo `mensageria.ts` fala com o assinante, não com o
prospecto: alerta de publicação, prazo, laudo pronto. Não existe função de
disparo em lote para lista prospectada, e isso está escrito no topo do arquivo
para que ninguém adicione depois sem perceber o que está fazendo.

Isso vira argumento de venda, não limitação: *"você não pode fazer disparo em
massa, e nós não vendemos isso. Vendemos o caso pronto."*

O canal legítimo que sobra, e que vale construir: **parceria com contadores**,
que não têm a vedação que recai sobre o advogado.

## Preço

Eles ancoraram o mercado em R$ 140 a 200 por mês. Não compensa competir por
preço de dado — compensa competir por valor de caso. O plano de R$ 49 existe
para entrar; a profundidade (tese, cálculo, laudo assinado) é o que sustenta
preço maior depois.
