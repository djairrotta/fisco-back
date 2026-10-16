declare module "pg-copy-streams" {
  import type { Writable, Readable } from "node:stream";
  export function from(sql: string): Writable;
  export function to(sql: string): Readable;
}
