import { Block, Tx } from "./types.js";
import { txid, merkleRoot, blockHash } from "./crypto.js";
import { DEFAULT_TARGET } from "./config.js";

export interface MineResult {
  block: Block | null;
  hash: string | null;
  iterations: number;
  exhausted: boolean;
}

// Teaching miner: bounded nonce budget, no background threads.
export function mineBlock(
  prev: string,
  height: number,
  txs: Tx[],
  target: string = DEFAULT_TARGET,
  maxIterations: number = 1_000_000,
  time?: number
): MineResult {
  const merkle = merkleRoot(txs.map(txid));
  const t = time ?? Date.now();
  const targetBig = BigInt(target);
  for (let nonce = 0; nonce < maxIterations; nonce++) {
    const header = { prev, height, time: t, target, nonce, merkle };
    const hash = blockHash(header);
    if (BigInt("0x" + hash) <= targetBig) {
      return { block: { header, txs }, hash, iterations: nonce + 1, exhausted: false };
    }
  }
  return { block: null, hash: null, iterations: maxIterations, exhausted: true };
}
