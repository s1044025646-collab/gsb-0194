import {
  blockHash,
  hashMeetsTarget,
  merkleRoot,
  txId,
  verifySignature,
  workOfTarget,
} from "./crypto.js";
import { ALLOWED_TARGETS } from "./config.js";
import type { Block, Transaction } from "./types.js";

export interface UtxoEntry {
  address: string;
  value: bigint;
}

export const pointKey = (txid: string, vout: number): string => `${txid}:${vout}`;

export class UtxoSet {
  map = new Map<string, UtxoEntry>();

  clone(): UtxoSet {
    const s = new UtxoSet();
    for (const [k, v] of this.map) s.map.set(k, { ...v });
    return s;
  }

  total(): bigint {
    let sum = 0n;
    for (const e of this.map.values()) sum += e.value;
    return sum;
  }

  balanceOf(address: string): bigint {
    let sum = 0n;
    for (const e of this.map.values()) if (e.address === address) sum += e.value;
    return sum;
  }

  utxosOf(address: string): Array<{ txid: string; vout: number; value: bigint }> {
    const out: Array<{ txid: string; vout: number; value: bigint }> = [];
    for (const [k, e] of this.map) {
      if (e.address === address) {
        const [txid, vout] = splitKey(k);
        out.push({ txid, vout, value: e.value });
      }
    }
    return out.sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));
  }
}

function splitKey(k: string): [string, number] {
  const idx = k.lastIndexOf(":");
  return [k.slice(0, idx), Number(k.slice(idx + 1))];
}

// 单区块应用时产生的可撤销变更
export interface BlockUndo {
  spent: Array<{ key: string; entry: UtxoEntry }>; // 被消费的输出（回退时恢复）
  added: string[];                                 // 新创建的输出（回退时删除）
  feeBurned: bigint;
}

export class ValidationError extends Error {}

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new ValidationError(msg);
}

/** 校验并应用一个区块到给定 UTXO 集合，返回可撤销记录。原地修改 utxo。 */
export function applyBlock(block: Block, utxo: UtxoSet, expectedHeight: number, expectedPrev: string): BlockUndo {
  // ---- 区块头校验 ----
  check(block.height === expectedHeight, `高度错误：期望 ${expectedHeight}，实际 ${block.height}`);
  check(block.prevHash === expectedPrev, "父块哈希不匹配");
  check(
    Object.values(ALLOWED_TARGETS).includes(block.target),
    "目标值不在固定允许集合中",
  );
  const h = blockHash(block);
  check(h === block.hash, `区块哈希不匹配：重算 ${h}`);
  check(hashMeetsTarget(h, block.target), `区块哈希 ${h} 不满足目标 ${block.target}`);
  const txRoot = merkleRoot(block.txs.map((t) => t.txid));
  check(txRoot === block.txRoot, `Merkle 根不匹配：重算 ${txRoot}，区块声明 ${block.txRoot}`);
  check(Number.isInteger(block.nonce) && block.nonce >= 0, "nonce 必须为非负整数");
  check(block.txs.length >= 1, "区块必须至少包含一笔交易");

  const undo: BlockUndo = { spent: [], added: [], feeBurned: 0n };
  const blockSpent = new Set<string>(); // 区块内防双花
  const seenTxIds = new Set<string>();

  for (let ti = 0; ti < block.txs.length; ti++) {
    const tx = block.txs[ti];
    try {
      validateTx(tx, block, ti, utxo, blockSpent, seenTxIds, undo);
    } catch (err) {
      // 回滚本区块已应用的改动，保证不留下半应用状态
      rollbackBlock(utxo, undo);
      throw err;
    }
  }
  return undo;
}

function validateTx(
  tx: Transaction,
  block: Block,
  txIndex: number,
  utxo: UtxoSet,
  blockSpent: Set<string>,
  seenTxIds: Set<string>,
  undo: BlockUndo,
): void {
  check(txId(tx) === tx.txid, "交易 txid 与重算结果不一致");
  check(!seenTxIds.has(tx.txid), `交易在区块内重复：${tx.txid}`);
  seenTxIds.add(tx.txid);

  // 创世铸币交易：只允许在高度 0 的第一笔，零输入
  const isGenesisMint = tx.inputs.length === 0;
  if (isGenesisMint) {
    check(block.height === 0 && txIndex === 0, "只有创世块的第一笔交易允许零输入铸币");
  }

  // 1) 输出非负（正整数），金额可解析
  let outTotal = 0n;
  for (const [i, o] of tx.outputs) {
    let v: bigint;
    try {
      v = BigInt(o.value);
    } catch {
      throw new ValidationError(`输出 #${i} 金额不是整数`);
    }
    check(v >= 0n, `输出 #${i} 金额为负`);
    check(o.address.length === 64 && /^[0-9a-f]+$/.test(o.address), `输出 #${i} 地址非法`);
    outTotal += v;
  }

  let inTotal = 0n;
  const localInputs = new Set<string>();
  for (const [i, input] of tx.inputs) {
    const key = pointKey(input.txid, input.vout);
    // 2) 同一笔交易内输入不重复
    check(!localInputs.has(key), `交易输入重复：${key}`);
    localInputs.add(key);
    // 3) 区块内不能双花（按交易公开顺序）
    check(!blockSpent.has(key), `区块内双花：${key} 已被同区块前序交易消费`);
    const entry = utxo.map.get(key);
    check(entry !== undefined, `引用的 UTXO 不存在：${key}`);
    // 4) 签名所有权
    const ok = verifySignature(entry.address, tx, input.sig);
    check(ok, `输入 ${key} 签名无效或不属于该地址`);
    inTotal += entry.value;
    blockSpent.add(key);
    undo.spent.push({ key, entry: { ...entry } });
    utxo.map.delete(key);
  }

  // 5) 输入总额覆盖输出；差额为手续费，本教学链中手续费被永久销毁
  const fee = inTotal - outTotal;
  check(fee >= 0n, `输入总额 ${inTotal} 小于输出总额 ${outTotal}`);
  undo.feeBurned += fee;

  tx.outputs.forEach((o, i) => {
    const key = pointKey(tx.txid, i);
    // 正常重组下不应冲突；防御性检查
    check(!utxo.map.has(key), `输出点已存在：${key}`);
    utxo.map.set(key, { address: o.address, value: BigInt(o.value) });
    undo.added.push(key);
  });
}

export function rollbackBlock(utxo: UtxoSet, undo: BlockUndo): void {
  for (const key of undo.added) utxo.map.delete(key);
  // 按消费的逆序恢复（同一 point 不会重复，逆序更稳妥）
  for (let i = undo.spent.length - 1; i >= 0; i--) {
    const { key, entry } = undo.spent[i];
    utxo.map.set(key, entry);
  }
  undo.added = [];
  undo.spent = [];
  undo.feeBurned = 0n;
}

/** 从空集重放一条链（blocks 必须按高度、从创世开始）得到 UTXO 集合。 */
export function replayChain(blocks: Block[]): { utxo: UtxoSet; burned: bigint } {
  const utxo = new UtxoSet();
  let burned = 0n;
  let prev = "0".repeat(64);
  for (const block of blocks) {
    const undo = applyBlock(block, utxo, block.height, prev);
    burned += undo.feeBurned;
    prev = block.hash;
  }
  return { utxo, burned };
}

export function chainWork(parentWork: bigint, target: string): bigint {
  return parentWork + workOfTarget(target);
}
