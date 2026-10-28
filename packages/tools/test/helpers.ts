import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { base58Decode, base58Encode, openDb, type Db, type ModuleContext } from "@crawlnet/shared";

export interface LogLine {
  msg: string;
  extra?: Record<string, unknown>;
}

/** A signature of a valid shape (the example in Solana's RPC docs) */
export const SIG = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7";

/** A tools context. TOOLS_SECURITY is "off" unless a test sets it (security.test.ts runs it). */
export function makeCtx(env: Record<string, string> = {}, db: Db = openDb(":memory:")): ModuleContext & { logs: LogLine[] } {
  const logs: LogLine[] = [];
  return { db, env: { TOOLS_SECURITY: "off", ...env }, log: (msg, extra) => logs.push({ msg, extra }), logs };
}

/** A fetch that answers from a table of URL prefix → JSON body (or a function), and records every URL. */
export function tableFetch(table: Record<string, unknown | ((url: string, init?: RequestInit) => unknown)>): { fetch: (url: string, init?: RequestInit) => Promise<Response>; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url: string, init?: RequestInit) => {
      urls.push(url);
      const key = Object.keys(table)
        .filter((k) => url.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (key === undefined) return new Response("not found", { status: 404 });
      const v = table[key];
      const body = typeof v === "function" ? await (v as (u: string, i?: RequestInit) => unknown)(url, init) : v;
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

/** A real Solana address (an ed25519 public key, on the curve) from a seed, the same on every run */
export function solKey(seed: string): string {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), createHash("sha256").update(seed).digest()]);
  const jwk = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "jwk" });
  return base58Encode(Buffer.from(String(jwk.x), "base64url"));
}

/** A wallet the tests use (made from a seed: no one's) */
export const SOL_A = solKey("sol-a");

/**
 * A Token Metadata account as the chain keeps it: kind 4, update authority, mint, then name, symbol and uri padded with
 * zeros, the seller fee, and the creators (address, verified, share) when there are any
 */
export function metadataBytes(update: string, mint: string, name: string, symbol: string, creators: [string, boolean][] = []): Buffer {
  const text = (t: string, n: number) => {
    const b = Buffer.alloc(4 + n);
    b.writeUInt32LE(n, 0);
    Buffer.from(t).copy(b, 4);
    return b;
  };
  const list = creators.length ? [Buffer.from([1, creators.length, 0, 0, 0]), ...creators.map(([a, v]) => Buffer.concat([Buffer.from(base58Decode(a)!), Buffer.from([v ? 1 : 0, 50])]))] : [Buffer.from([0])];
  return Buffer.concat([Buffer.from([4]), Buffer.from(base58Decode(update)!), Buffer.from(base58Decode(mint)!), text(name, 32), text(symbol, 10), text("", 200), Buffer.from([0, 0]), ...list, Buffer.from([1, 0])]);
}
