import { z } from "zod";
import { decryptString, encryptString } from "./crypto.js";

export const environmentSchema = z.object({ entries: z.array(z.object({
  name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).refine(n => !/^(PATH|HOME|USER|SHELL|TMPDIR|PYTHON.*|LD_.*|DYLD_.*|CRUNCH_.*|NICEMETA_.*|JWT_.*|DATA_KEY|PYTHON_ENGINE_.*)$/.test(n), "Reserved process variable name"),
  value: z.string().max(65536).nullable(),
  secret: z.boolean(),
})).max(100) }).superRefine(({entries}, ctx) => {
  if (new Set(entries.map(e => e.name)).size !== entries.length) ctx.addIssue({code: "custom", message: "Variable names must be unique"});
});
type Entry = {name: string; value: string; secret: boolean};
export function readEnvironment(sealed: unknown): Entry[] {
  return sealed ? JSON.parse(decryptString(String(sealed))) : [];
}
export function publicEnvironment(sealed: unknown) {
  return {entries: readEnvironment(sealed).map(e => ({...e, value: e.secret ? null : e.value}))};
}
export function saveEnvironment(input: unknown, sealed: unknown): string {
  const {entries} = environmentSchema.parse(input);
  const previous = readEnvironment(sealed);
  const merged = entries.map(e => {
    if (e.value !== null) return e;
    const old = previous.find(p => p.name === e.name && p.secret);
    if (!e.secret || !old) throw new Error(`Enter a value for ${e.name}`);
    return {...e, value: old.value};
  });
  return encryptString(JSON.stringify(merged));
}
export function redactEnvironment<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") return secrets.filter(Boolean).sort((a,b) => b.length-a.length).reduce((s, secret) => s.split(secret).join("[REDACTED]"), value) as T;
  if (Array.isArray(value)) return value.map(v => redactEnvironment(v, secrets)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [redactEnvironment(k, secrets), redactEnvironment(v,secrets)])) as T;
  return value;
}
