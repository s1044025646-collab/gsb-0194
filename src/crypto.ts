import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey, KeyObject } from "node:crypto";
import { Tx, BlockHeader } from "./types.js";

export function sha256hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// Deterministic canonical serialization: sorted object keys, BigInt -> string.
export function canonical(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
  }
  throw new Error("cannot canonicalize " + typeof value);
}

export function txid(tx: Tx): string {
  return sha256hex(canonical(tx));
}

export function merkleRoot(txids: string[]): string {
  if (txids.length === 0) return sha256hex("empty");
  let layer = txids.slice();
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i];
      const b = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(sha256hex(a + b));
    }
    layer = next;
  }
  return layer[0];
}

export function blockHash(header: BlockHeader): string {
  return sha256hex(canonical(header));
}

// Message signed by each input: txid of the tx with all signatures blanked, plus input index.
export function sighash(tx: Tx, inputIndex: number): string {
  const copy: Tx = JSON.parse(JSON.stringify(tx));
  for (const inp of copy.inputs) inp.signature = "";
  return sha256hex(canonical(copy) + ":" + inputIndex);
}

export interface KeyPairHex { publicKey: string; privateKey: string; address: string; }

export function generateKeyPair(): KeyPairHex {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" }).toString("hex");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" }).toString("hex");
  return { publicKey: pubDer, privateKey: privDer, address: addressOf(pubDer) };
}

export function addressOf(pubkeyHex: string): string {
  return sha256hex(Buffer.from(pubkeyHex, "hex"));
}

export function signMessage(privDerHex: string, msgHex: string): string {
  const key = createPrivateKey({ key: Buffer.from(privDerHex, "hex"), format: "der", type: "pkcs8" });
  return edSign(null, Buffer.from(msgHex, "hex"), key).toString("hex");
}

export function verifyMessage(pubDerHex: string, msgHex: string, sigHex: string): boolean {
  try {
    const key: KeyObject = createPublicKey({ key: Buffer.from(pubDerHex, "hex"), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(msgHex, "hex"), key, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

export function derivePublicKey(privDerHex: string): string {
  const priv = createPrivateKey({ key: Buffer.from(privDerHex, "hex"), format: "der", type: "pkcs8" });
  return createPublicKey(priv).export({ type: "spki", format: "der" }).toString("hex");
}
