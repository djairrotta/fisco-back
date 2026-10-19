// Gera os segredos do Vigia. Uso: deno run --allow-env scripts/gerar-chaves.ts
import webpush from "web-push";

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const vapid = webpush.generateVAPIDKeys();
const convite = Array.from(rand(16), (x) => x.toString(16).padStart(2, "0"))
  .join("");

console.log(`VIGIA_MASTER_KEY=${b64(rand(32))}`);
console.log(`VAPID_PUBLIC_KEY=${vapid.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${vapid.privateKey}`);
console.log(`VIGIA_INVITE_CODE=${convite}`);
console.log(
  "\nGuarde estes valores. Trocar a VIGIA_MASTER_KEY depois invalida os segredos já salvos.",
);
