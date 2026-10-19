import { assert, assertEquals } from "@std/assert";
import { conferirSenha, gerarHashSenha, loginSenhaValido } from "../src/auth/senha.ts";

Deno.test("hash PBKDF2: confere a senha certa e recusa a errada", async () => {
  const h = await gerarHashSenha("senha-de-teste-123", 100_000);
  assert(h.startsWith("pbkdf2$100000$"));
  assert(await conferirSenha("senha-de-teste-123", h));
  assert(!(await conferirSenha("senha-de-teste-124", h)));
  assert(!(await conferirSenha("x", "md5$abc")));
});

Deno.test("login: usuário sem diferenciar maiúsculas, senha exata, desligado sem config", async () => {
  const cfg = { usuario: "djair", hash: await gerarHashSenha("Uma-Senha-Forte-9", 100_000) };
  assert(await loginSenhaValido(" Djair ", "Uma-Senha-Forte-9", cfg));
  assertEquals(await loginSenhaValido("djair", "uma-senha-forte-9", cfg), false);
  assertEquals(await loginSenhaValido("outro", "Uma-Senha-Forte-9", cfg), false);
  assertEquals(await loginSenhaValido("djair", "Uma-Senha-Forte-9", null), false);
});
