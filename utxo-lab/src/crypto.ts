import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPrivateKey,
  createPublicKey,
  KeyObject,
} from "node:crypto";
import type { Block, BlockHeaderLike, Transaction, TxBody, TxIn, TxOut } from "./types.js";

// ---------- 确定性序列化 ----------
// 规则：对象键按字典序排序，数组保持顺序，无多余空白，hex/字符串/数字原样。
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

export function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

// 双 SHA-256，与教学比特币一致
export function hash256Hex(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return createHash("sha256").update(createHash("sha256").update(buf).digest()).digest("hex");
}

// ---------- 交易 ----------
export function txBody(tx: Transaction): TxBody {
  return {
    inputs: tx.inputs.map((i) => ({ txid: i.txid, vout: i.vout })),
    outputs: tx.outputs.map((o) => ({ address: o.address, value: o.value })),
  };
}

export function txId(tx: Transaction): string {
  return hash256Hex(canonical(txBody(tx)));
}

export function signingMessage(tx: Transaction): Buffer {
  return Buffer.from(hash256Hex(canonical(txBody(tx))), "hex");
}

// ---------- Merkle 根 ----------
export function merkleRoot(txids: string[]): string {
  if (txids.length === 0) return hash256Hex(Buffer.alloc(0));
  let level = txids.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = Buffer.from(level[i], "hex");
      const b = Buffer.from(level[i + 1] ?? level[i], "hex"); // 奇数个则复制最后一个
      next.push(hash256Hex(Buffer.concat([a, b])));
    }
    level = next;
  }
  return level[0];
}

// ---------- 区块头 / 工作量 ----------
export function blockHeaderLike(block: Block): BlockHeaderLike {
  return {
    height: block.height,
    prevHash: block.prevHash,
    timestamp: block.timestamp,
    target: block.target,
    nonce: block.nonce,
    txRoot: merkleRoot(block.txs.map((t) => t.txid)),
  };
}

export function blockHash(block: Block): string {
  return hash256Hex(canonical(blockHeaderLike(block)));
}

export function hashMeetsTarget(hashHex: string, targetHex: string): boolean {
  const h = BigInt("0x" + hashHex);
  const t = BigInt("0x" + targetHex);
  return h <= t;
}

// 一个目标值对应的工作量：floor(2^256 / (target + 1))
export function workOfTarget(targetHex: string): bigint {
  const t = BigInt("0x" + targetHex);
  return (1n << 256n) / (t + 1n);
}

// ---------- Ed25519 密钥与签名 ----------
export interface KeyPair {
  privateKeyHex: string; // PKCS8 DER hex（仅在本机生成/签名时出现，不进公开查询）
  publicKeyHex: string;  // 原始 32 字节公钥 hex，即地址
}

export function generateKeypair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  const pubRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { privateKeyHex: privDer.toString("hex"), publicKeyHex: pubRaw.toString("hex") };
}

export function privateKeyObject(privateKeyHex: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(privateKeyHex, "hex"), format: "der", type: "pkcs8" });
}

export function publicKeyObjectFromRaw(publicKeyHex: string): KeyObject {
  const pubRaw = Buffer.from(publicKeyHex, "hex");
  if (pubRaw.length !== 32) throw new Error("地址必须是 32 字节 Ed25519 公钥 hex");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, pubRaw]),
    format: "der",
    type: "spki",
  });
}

export function signTx(privateKeyHex: string, tx: Transaction): string {
  const sig = edSign(null, signingMessage(tx), privateKeyObject(privateKeyHex));
  return sig.toString("hex");
}

export function verifySignature(publicKeyHex: string, tx: Transaction, sigHex: string): boolean {
  try {
    return edVerify(null, signingMessage(tx), publicKeyObjectFromRaw(publicKeyHex), Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

// ---------- 组装辅助 ----------
export function makeTransaction(inputs: TxIn[], outputs: TxOut[]): Transaction {
  const tx: Transaction = { txid: "", inputs, outputs };
  tx.txid = txId(tx);
  return tx;
}
