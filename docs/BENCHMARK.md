# Benchmark de modelos — por que Haiku 5.5 sem raciocínio

Medição própria em 2026-10-16: 12 casos reais de ficha de empresa, 3 modelos,
com e sem raciocínio, 2 repetições — **144 chamadas**. Custo apurado pelo campo
`usage` da própria OpenRouter, não estimado.

Sete dos doze casos são armadilhas: CNPJ ausente, três valores concorrentes no
texto, regime fora do enum, contradição na ficha, prescrição, ficha vazia e
injeção de prompt.

| Modelo | Raciocínio | Campos objetivos | JSON/schema | Alucinação | Custo/peça |
|---|---|---|---|---|---|
| Haiku 5.5 | desligado | 99,6% | 100% | 0 | R$ 0,0016 |
| DeepSeek V4.1 Flash | desligado | 99,6% | 100% | 0 | R$ 0,0013 |
| Haiku 5.5 | ligado | 99,6% | 100% | 0 | R$ 0,0026 |
| GLM 5.3 Flash | obrigatório | 99,2% | 95,8% | 0 | R$ 0,0036 |
| DeepSeek V4.1 Flash | ligado | 98,9% | 100% | 0 | R$ 0,0047 |

## O que decidiu

1. **Zero alucinação nos três.** Em 119 execuções válidas nenhum inventou CNPJ,
   valor ou data. Campo ausente voltou `null`.
2. **Ninguém obedeceu à injeção de prompt** — 10/10 mantiveram o valor correto.
3. **O GLM não permite desligar o raciocínio** (`Reasoning is mandatory for this
   endpoint`). Paga ~986 tokens de raciocínio por chamada, cobrados como saída.
   É o mais caro apesar da entrada mais barata, e o único que quebrou schema.
4. **Desligar o raciocínio melhora tudo:** saída de 623 → 274 tokens, latência
   de 6,2s → 2,6s, custo quase pela metade, precisão igual ou melhor.

## O erro está num campo só

Dos 119 erros de campo, **53 estão em `exige_analise_advogado`**. Todo o resto é
quase perfeito: `periodo_inicio` errou 2×, `tributo` 2×, `razao_social` 2×,
`uf` 1×, `regime_tributario` 1×.

Extrair dado objetivo: 99,6%. Julgar se o caso exige advogado: nenhum é confiável.
**Por isso esse campo nunca decide sozinho** — ele só levanta bandeira na interface.

A direção do erro decidiu o modelo: o Haiku sem raciocínio errou 10× para mais
(pediu revisão sem precisar) e **zero vezes para menos**. O DeepSeek deixou passar
2 casos que precisavam de revisão. Errar para mais custa um minuto do advogado;
errar para menos manda para protocolo peça com prescrição não avaliada.

## Custo em produção

R$ 0,048 por assinante/mês no teto de 30 peças.

## Repetir

O benchmark roda em ~1 minuto. **Refaça com as peças reais** quando o modelo de
petição validado existir — os casos aqui são sintéticos.
