// Documento OpenAPI 3.1 da API v1, gerado da mesma tabela de operações.
import { esquemaEntrada, OPERACOES } from "./operacoes.ts";
import { VERSAO_VIGIA } from "../../mcp/servidor.ts";

let cache: Record<string, unknown> | null = null;

export function documentoOpenApi(): Record<string, unknown> {
  if (cache) return cache;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERACOES) {
    const caminho = op.caminho.replace(/:(\w+)/g, "{$1}");
    const params = [...op.caminho.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const esquema = esquemaEntrada(op) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const props = esquema.properties ?? {};
    const req = new Set(esquema.required ?? []);
    const parametros = [
      ...params.map((p) => ({
        name: p,
        in: "path",
        required: true,
        schema: props[p] ?? { type: "string" },
      })),
      ...(op.metodo === "GET"
        ? Object.entries(props).filter(([k]) => !params.includes(k)).map((
          [k, s],
        ) => ({ name: k, in: "query", required: req.has(k), schema: s }))
        : []),
    ];
    const corpoProps = Object.fromEntries(
      Object.entries(props).filter(([k]) => !params.includes(k)),
    );
    const temCorpo = op.metodo !== "GET" && Object.keys(corpoProps).length > 0;
    paths[caminho] ??= {};
    paths[caminho][op.metodo.toLowerCase()] = {
      operationId: op.nome,
      summary: op.descricao,
      tags: [op.escopo === "ler" ? "leitura" : "escrita"],
      security: [{ token: [] }],
      "x-escopo": op.escopo,
      ...(parametros.length ? { parameters: parametros } : {}),
      ...(temCorpo
        ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: corpoProps,
                  required: [...req].filter((k) => !params.includes(k)),
                  additionalProperties: false,
                },
              },
            },
          },
        }
        : {}),
      responses: {
        "200": { description: "OK (JSON)" },
        "400": { description: "Dados inválidos" },
        "401": { description: "Token ausente, inválido ou revogado" },
        "403": { description: "Token sem o escopo exigido" },
        "404": { description: "Não encontrado" },
        "409": { description: "Conflito (ex.: IP protegido)" },
        "429": { description: "Mais de 60 requisições/min (Retry-After)" },
        "502": { description: "Falha no Cloudflare ou na IA" },
      },
    };
  }
  cache = {
    openapi: "3.1.0",
    info: {
      title: "Vigia API",
      version: VERSAO_VIGIA,
      description:
        "API do Vigia. Autenticação: Authorization: Bearer vgt_… (token criado em Config → Integrações). Escopo `ler` para leitura; `escrever` inclui leitura. Toda escrita vai para a auditoria como token:<id>:<nome>.",
    },
    servers: [{ url: "/api/v1" }],
    components: {
      securitySchemes: {
        token: { type: "http", scheme: "bearer", bearerFormat: "vgt_" },
      },
    },
    paths,
  };
  return cache;
}
