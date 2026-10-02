import { ChainDB, BlockRow } from "./db.js";
import { Chain, ChainError, validateTxStructure } from "./chain.js";
import { Block, Tx, TxOutput } from "./types.js";
import { txid, sighash, signMessage, derivePublicKey, generateKeyPair, KeyPairHex } from "./crypto.js";
import { mineBlock, MineResult } from "./miner.js";
import { DEFAULT_TARGET, FEE_POLICY } from "./config.js";

export class Service {
  chain: Chain;
  constructor(public store: ChainDB) {
    this.chain = new Chain(store);
  }

  keygen(): KeyPairHex { return generateKeyPair(); }

  createGenesis(allocations: Array<{ address: string; amount: string }>, target: string = DEFAULT_TARGET): { hash: string } {
    const tx: Tx = { version: 1, inputs: [], outputs: allocations.map((a) => ({ address: a.address, amount: a.amount })) };
    const res = mineBlock("0".repeat(64), 0, [tx], target, 10_000_000);
    if (!res.block) throw new ChainError("genesis mining budget exhausted");
    return { hash: this.chain.acceptBlock(res.block).hash };
  }

  // Sign a transaction: inputs reference UTXOs owned by the given private key.
  signTx(
    inputs: Array<{ txid: string; vout: number }>,
    outputs: TxOutput[],
    privateKey: string
  ): Tx {
    const pubkey = derivePublicKey(privateKey);
    const tx: Tx = {
      version: 1,
      inputs: inputs.map((i) => ({ txid: i.txid, vout: i.vout, pubkey, signature: "" })),
      outputs,
    };
    tx.inputs = tx.inputs.map((inp, i) => ({ ...inp, signature: signMessage(privateKey, sighash(tx, i)) }));
    validateTxStructure(tx);
    return tx;
  }

  submitTx(tx: Tx): { txid: string } {
    validateTxStructure(tx);
    const id = txid(tx);
    this.store.mempoolAdd(id, JSON.stringify(tx));
    return { txid: id };
  }

  // Mine a block on the current tip with mempool txs, bounded budget.
  mine(maxIterations: number = 1_000_000, target: string = DEFAULT_TARGET): MineResult & { status?: string } {
    const tip = this.store.getMeta("tip");
    if (!tip) throw new ChainError("no genesis block");
    const tipRow = this.store.getBlock(tip)!;
    const txs: Tx[] = this.store.mempoolAll().map((m) => JSON.parse(m.tx));
    const res = mineBlock(tip, tipRow.height + 1, txs, target, maxIterations);
    if (!res.block) return res;
    const accepted = this.chain.acceptBlock(res.block);
    return { ...res, status: accepted.status };
  }

  importBlock(block: Block): { hash: string; status: string } {
    return this.chain.acceptBlock(block);
  }

  tip(): unknown {
    const t = this.store.getMeta("tip");
    if (!t) return null;
    const row = this.store.getBlock(t)!;
    return { hash: t, height: row.height, cumwork: row.cumwork, target: row.target };
  }

  getBlock(hash: string): unknown {
    const row = this.store.getBlock(hash);
    if (!row) return null;
    return { ...row, block: this.store.blockFromRow(row) };
  }

  getTx(txidHex: string): unknown {
    for (const row of this.store.allBlocks()) {
      const txs = JSON.parse(row.txs) as Tx[];
      for (const tx of txs) {
        if (txid(tx) === txidHex) {
          return { tx, block: row.hash, blockHeight: row.height, branchStatus: row.status };
        }
      }
    }
    return null;
  }

  commonAncestor(a: string, b: string): unknown {
    const r = this.chain.commonAncestor(a, b);
    return r ? { hash: r.hash, height: r.height, cumwork: r.cumwork } : null;
  }

  compareForks(a: string, b: string): unknown {
    const ra = this.store.getBlock(a);
    const rb = this.store.getBlock(b);
    if (!ra || !rb) throw new ChainError("unknown block hash");
    const anc = this.chain.commonAncestor(a, b);
    const best = this.chain.bestConnected();
    return {
      a: { hash: a, height: ra.height, cumwork: ra.cumwork, status: ra.status },
      b: { hash: b, height: rb.height, cumwork: rb.cumwork, status: rb.status },
      commonAncestor: anc ? { hash: anc.hash, height: anc.height } : null,
      selectedTip: best ? best.hash : null,
      tieBreakRule: "higher cumulative work wins; equal work -> lowest block hash wins",
    };
  }

  balanceProof(address: string): unknown {
    const utxos = this.store.utxosOf(address);
    let total = 0n;
    const items = utxos.map((u) => {
      total += BigInt(u.amount);
      return { txid: u.txid, vout: u.vout, amount: u.amount };
    });
    return { address, balance: total.toString(), utxoCount: items.length, utxos: items, feePolicy: FEE_POLICY };
  }

  verify(): unknown {
    return this.chain.verifyConsistency();
  }

  forks(): unknown {
    const rows = this.store.allBlocks();
    return rows.map((r: BlockRow) => ({
      hash: r.hash, prev: r.prev, height: r.height, cumwork: r.cumwork, status: r.status,
    }));
  }
}
