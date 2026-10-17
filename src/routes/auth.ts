/**
 * Autenticacao. Nao existia nada disso: /app abria sem login.
 *
 * Decisoes:
 *  - JWT curto (12h) no corpo da resposta; quem guarda em cookie
 *    httpOnly e o Next, para o token nunca passar por JavaScript de
 *    pagina e sobreviver a XSS.
 *  - Resposta IGUAL para e-mail inexistente e senha errada, para nao
 *    virar oraculo de quem e cliente.
 *  - Trava de forca bruta por e-mail no banco, nao em memoria: memoria
 *    some a cada deploy e a trava ia junto.
 */
import type { FastifyInstance } from "fastify";
import { q, pool } from "../db/pool.js";
import { gerarHash, conferirSenha, senhaFraca } from "../services/senha.js";

const JANELA_MIN = 15;
const MAX_FALHAS = 8;

interface Corpo { email?: string; senha?: string; nome?: string; oab?: string }

export default async function rotasAuth(app: FastifyInstance) {
  app.post<{ Body: Corpo }>("/api/auth/registrar", async (req, reply) => {
    const email = (req.body?.email || "").trim().toLowerCase();
    const senha = req.body?.senha || "";
    const nome = (req.body?.nome || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return reply.code(400).send({ erro: "E-mail inválido." });
    if (!nome) return reply.code(400).send({ erro: "Informe o nome." });
    const fraca = senhaFraca(senha);
    if (fraca) return reply.code(400).send({ erro: fraca });

    const [existe] = await q(`SELECT 1 FROM usuario WHERE lower(email) = $1`, [email]);
    if (existe) return reply.code(409).send({ erro: "Já existe conta com esse e-mail." });

    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const { rows: [t] } = await c.query(
        `INSERT INTO tenant (nome, email, oab, plano, usuarios_max, cidades_max)
         VALUES ($1,$2,$3,'documentacao',1,1) RETURNING id`,
        [nome, email, (req.body?.oab || "").trim() || null]
      );
      const { rows: [u] } = await c.query(
        `INSERT INTO usuario (tenant_id, nome, email, senha_hash, papel)
         VALUES ($1,$2,$3,$4,'dono') RETURNING id`,
        [t.id, nome, email, await gerarHash(senha)]
      );
      await c.query(`SELECT semear_funil($1)`, [t.id]).catch(() => {});
      await c.query("COMMIT");
      const token = app.jwt.sign({ sub: u.id, tenant: t.id, papel: "dono" }, { expiresIn: "12h" });
      return reply.code(201).send({ token, usuario: { id: u.id, nome, email, papel: "dono" } });
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { c.release(); }
  });

  app.post<{ Body: Corpo }>("/api/auth/login", async (req, reply) => {
    const email = (req.body?.email || "").trim().toLowerCase();
    const senha = req.body?.senha || "";
    const ip = req.ip;
    const generico = { erro: "E-mail ou senha incorretos." };

    const [{ falhas }] = await q<{ falhas: string }>(
      `SELECT count(*) AS falhas FROM tentativa_login
        WHERE lower(email) = $1 AND NOT sucesso AND em > now() - ($2 || ' minutes')::interval`,
      [email, String(JANELA_MIN)]
    );
    if (Number(falhas) >= MAX_FALHAS)
      return reply.code(429).send({ erro: `Muitas tentativas. Tente de novo em ${JANELA_MIN} minutos.` });

    const [u] = await q<any>(
      `SELECT u.id, u.nome, u.email, u.senha_hash, u.papel, u.ativo,
              t.id AS tenant_id, t.plano, t.ativo AS tenant_ativo
         FROM usuario u JOIN tenant t ON t.id = u.tenant_id
        WHERE lower(u.email) = $1`, [email]
    );

    const ok = u && u.ativo && u.tenant_ativo && await conferirSenha(senha, u.senha_hash);
    await pool.query(
      `INSERT INTO tentativa_login (email, ip, sucesso) VALUES ($1,$2,$3)`,
      [email, ip, !!ok]
    );
    if (!ok) return reply.code(401).send(generico);

    await pool.query(`UPDATE usuario SET ultimo_login = now() WHERE id = $1`, [u.id]);
    const token = app.jwt.sign(
      { sub: u.id, tenant: u.tenant_id, papel: u.papel }, { expiresIn: "12h" });
    return { token, usuario: { id: u.id, nome: u.nome, email: u.email, papel: u.papel, plano: u.plano } };
  });

  app.get("/api/auth/eu", { onRequest: [(app as any).authenticate] }, async (req: any) => {
    const [u] = await q<any>(
      `SELECT u.id, u.nome, u.email, u.papel, t.id AS tenant_id, t.nome AS escritorio,
              t.plano, t.pecas_mes, t.pecas_usadas, t.cidades_max, t.usuarios_max
         FROM usuario u JOIN tenant t ON t.id = u.tenant_id WHERE u.id = $1`,
      [req.user.sub]
    );
    return u ?? {};
  });
}
