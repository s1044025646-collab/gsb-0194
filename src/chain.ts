import { ChainDB, BlockRow } from "./db.js";
import { Block, Tx, UtxoRec, UndoRec } from "./types.js";
import { txid, merkleRoot, blockHash, sighash, verifyMessage, addressOf, sha256hex } from "./crypto.js";
import { ALLOWED_TARGETS, workOfTarget } from "./config.js";

export class ChainError extends Error {}

// ---- Test hook: throw mid-reorg to prove atomic rollback. ----
let reorgFailHook: ((phase: string, blockHash: string) => void) | null = null;
export function setReorgFailHook(fn: typeof reorgFailHook): void { reorgFailHook = fn; }

export function isValidAmountString(s: string): boolean {
  return typeof s === "string" && /^[0-9]+$/.test(s);
}

// Structural checks that do not require UTXO state.
export function validateTxStructure(tx: Tx): void {
  if (tx.version !== 1) throw new ChainError("unsupported tx version");
  const seen = new Set<string>();
  for (const inp of tx.inputs) {
    const key = inp.txid + ":" + inp.vout;
    if (seen.has(key)) throw new ChainError("duplicate input inside tx: " + key);
    seen.add(key);
  }
  for (const out of tx.outputs) {
    if (!isValidAmountString(out.amount)) throw new ChainError("invalid amount encoding");
    if (BigInt(out.amount) < 0n) throw new ChainError("negative output");
  }
  // Signatures verify against the tx sighash (ownership vs referenced output is
  // checked at connect time when the UTXO is known).
  for (let i = 0; i < tx.inputs.length; i++) {
    const inp = tx.inputs[i];
    if (!verifyMessage(inp.pubkey, sighash(tx, i), inp.signature)) {
      throw new ChainError("bad signature on input " + i);
    }
  }
}

export function validateBlockHeader(block: Block, hash: string): void {
  const h = block.header;
  if (!ALLOWED_TARGETS.includes(h.target)) throw new ChainError("target not in allowed set");
  const ids = block.txs.map(txid);
  if (merkleRoot(ids) !== h.merkle) throw new ChainError("merkle root mismatch");
  const target = BigInt(h.target);
  const hv = BigInt("0x" + hash);
  if (hv > target) throw new ChainError("insufficient proof of work");
}

export class Chain {
  constructor(public store: ChainDB) {}

  tipHash(): string | null { return this.store.getMeta("tip"); }

  bestConnected(): BlockRow | null {
    const rows = [...this.store.blocksByStatus("main"), ...this.store.blocksByStatus("side")];
    if (rows.length === 0) return null;
    let best = rows[0];
    for (const r of rows) {
      const cw = BigInt(r.cumwork!);
      const bw = BigInt(best.cumwork!);
      if (cw > bw || (cw === bw && r.hash < best.hash)) best = r; // deterministic tie-break: lowest hash
    }
    return best;
  }

  // Accept a block from anywhere (mined locally or imported).
  // Returns status: main | side | orphan.
  acceptBlock(block: Block): { hash: string; status: string } {
    const hash = blockHash(block.header);
    const existing = this.store.getBlock(hash);
    if (existing && existing.status !== "orphan") {
      // Re-evaluate chain selection: a previous reorg attempt may have failed.
      const best = this.bestConnected();
      if (best && best.hash !== this.tipHash()) this.reorgTo(best.hash);
      return { hash, status: this.store.getBlock(hash)!.status };
    }

    validateBlockHeader(block, hash);
    for (const tx of block.txs) validateTxStructure(tx);

    const h = block.header;
    const work = workOfTarget(BigInt(h.target));

    if (h.height === 0) {
      if (h.prev !== "0".repeat(64)) throw new ChainError("genesis prev must be zero");
      if (this.tipHash() !== null) throw new ChainError("genesis already exists");
      if (block.txs.length !== 1 || block.txs[0].inputs.length !== 0) {
        throw new ChainError("genesis must contain exactly one allocation tx with no inputs");
      }
      this.connectGenesis(block, hash);
      this.tryOrphans(hash);
      return { hash, status: "main" };
    }

    const parent = this.store.getBlock(h.prev);
    if (!parent || parent.status === "orphan" || parent.status === "invalid") {
      // Missing parent: park as orphan, never merge into main chain.
      if (existing) this.store.setBlockStatus(hash, "orphan", null as unknown as string);
      else this.store.insertBlock(hash, block, null, "orphan");
      return { hash, status: "orphan" };
    }
    if (parent.height + 1 !== h.height) throw new ChainError("height mismatch with parent");

    const cumwork = (BigInt(parent.cumwork!) + work).toString();
    if (existing) this.store.setBlockStatus(hash, "side", cumwork);
    else this.store.insertBlock(hash, block, cumwork, "side");

    const best = this.bestConnected()!;
    const tip = this.tipHash();
    if (best.hash !== tip) {
      this.reorgTo(best.hash);
    } else {
      this.store.setBlockStatus(hash, "side", cumwork);
    }
    this.tryOrphans(hash);
    const finalRow = this.store.getBlock(hash)!;
    return { hash, status: finalRow.status };
  }

  private connectGenesis(block: Block, hash: string): void {
    this.store.db.exec("BEGIN");
    try {
      const undo: UndoRec = { created: [], spent: [] };
      const tx = block.txs[0];
      const id = txid(tx);
      tx.outputs.forEach((o, i) => {
        if (!isValidAmountString(o.amount)) throw new ChainError("invalid genesis amount");
        this.store.addUtxo({ txid: id, vout: i, address: o.address, amount: o.amount });
        undo.created.push({ txid: id, vout: i });
      });
      this.store.insertBlock(hash, block, workOfTarget(BigInt(block.header.target)).toString(), "main");
      this.store.setUndo(hash, undo);
      this.store.setMeta("tip", hash);
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
  }

  private chainToGenesis(hash: string): BlockRow[] {
    const out: BlockRow[] = [];
    let cur = this.store.getBlock(hash);
    while (cur) {
      out.push(cur);
      if (cur.height === 0) break;
      cur = this.store.getBlock(cur.prev);
    }
    return out.reverse();
  }

  commonAncestor(aHash: string, bHash: string): BlockRow | null {
    const a = this.chainToGenesis(aHash);
    const bSet = new Map(this.chainToGenesis(bHash).map((r) => [r.hash, r]));
    for (let i = a.length - 1; i >= 0; i--) {
      if (bSet.has(a[i].hash)) return a[i];
    }
    return null;
  }

  // Reorganize main chain to newTip, atomically. Any failure rolls everything back.
  reorgTo(newTip: string): void {
    const oldTip = this.tipHash();
    if (oldTip === newTip) return;
    const ancestor = this.commonAncestor(oldTip!, newTip);
    if (!ancestor) throw new ChainError("no common ancestor");

    const oldChain = this.chainToGenesis(oldTip!);
    const newChain = this.chainToGenesis(newTip);
    const disconnect = oldChain.filter((r) => r.height > ancestor.height).reverse(); // tip -> down
    const connect = newChain.filter((r) => r.height > ancestor.height); // up -> tip

    this.store.db.exec("BEGIN");
    try {
      for (const row of disconnect) {
        if (reorgFailHook) reorgFailHook("disconnect", row.hash);
        this.disconnectBlock(row);
      }
      for (const row of connect) {
        if (reorgFailHook) reorgFailHook("connect", row.hash);
        this.connectBlock(row);
      }
      this.store.setMeta("tip", newTip);
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
  }

  private disconnectBlock(row: BlockRow): void {
    const undo = this.store.getUndo(row.hash);
    if (!undo) throw new ChainError("missing undo data for " + row.hash);
    for (const c of undo.created) this.store.delUtxo(c.txid, c.vout);
    for (const s of undo.spent) this.store.addUtxo(s);
    this.store.setBlockStatus(row.hash, "side");
  }

  // Validate block txs against current UTXO view and apply. Records undo data.
  private connectBlock(row: BlockRow): void {
    const block = this.store.blockFromRow(row);
    const undo: UndoRec = { created: [], spent: [] };
    if (row.height === 0) {
      // genesis reconnect
      const tx = block.txs[0];
      const id = txid(tx);
      tx.outputs.forEach((o, i) => {
        this.store.addUtxo({ txid: id, vout: i, address: o.address, amount: o.amount });
        undo.created.push({ txid: id, vout: i });
      });
      this.store.setUndo(row.hash, undo);
      this.store.setBlockStatus(row.hash, "main");
      return;
    }
    const inBlockSpent = new Set<string>();
    for (const tx of block.txs) {
      if (tx.inputs.length === 0) throw new ChainError("non-genesis tx with no inputs");
      let inSum = 0n;
      for (let i = 0; i < tx.inputs.length; i++) {
        const inp = tx.inputs[i];
        const key = inp.txid + ":" + inp.vout;
        if (inBlockSpent.has(key)) throw new ChainError("in-block double spend: " + key);
        const u = this.store.getUtxo(inp.txid, inp.vout);
        if (!u) throw new ChainError("input not found in UTXO set: " + key);
        if (addressOf(inp.pubkey) !== u.address) throw new ChainError("signature ownership mismatch: " + key);
        inBlockSpent.add(key);
        inSum += BigInt(u.amount);
        undo.spent.push(u);
        this.store.delUtxo(inp.txid, inp.vout);
      }
      let outSum = 0n;
      for (const o of tx.outputs) outSum += BigInt(o.amount);
      if (inSum < outSum) throw new ChainError("inputs do not cover outputs");
      // fee = inSum - outSum is burned (FEE_POLICY = "burned")
      const id = txid(tx);
      tx.outputs.forEach((o, i) => {
        const rec: UtxoRec = { txid: id, vout: i, address: o.address, amount: o.amount };
        this.store.addUtxo(rec);
        undo.created.push({ txid: id, vout: i });
      });
      this.store.mempoolDel(id);
    }
    this.store.setUndo(row.hash, undo);
    this.store.setBlockStatus(row.hash, "main");
  }

  private tryOrphans(parentHash: string): void {
    for (const orphan of this.store.orphansOf(parentHash)) {
      const block = this.store.blockFromRow(orphan);
      this.acceptBlock(block);
    }
  }

  // Independent full replay of the current main chain from genesis.
  replayMain(): { utxos: Map<string, UtxoRec>; conserved: boolean } {
    const tip = this.tipHash();
    if (!tip) return { utxos: new Map(), conserved: true };
    const chain = this.chainToGenesis(tip);
    const utxos = new Map<string, UtxoRec>();
    let genesisSum = 0n;
    for (const row of chain) {
      const block = this.store.blockFromRow(row);
      for (const tx of block.txs) {
        const id = txid(tx);
        let inSum = 0n;
        for (const inp of tx.inputs) {
          const u = utxos.get(inp.txid + ":" + inp.vout);
          if (!u) throw new ChainError("replay: missing input");
          inSum += BigInt(u.amount);
          utxos.delete(inp.txid + ":" + inp.vout);
        }
        let outSum = 0n;
        tx.outputs.forEach((o, i) => {
          outSum += BigInt(o.amount);
          utxos.set(id + ":" + i, { txid: id, vout: i, address: o.address, amount: o.amount });
        });
        if (row.height === 0) genesisSum += outSum;
        else if (inSum < outSum) throw new ChainError("replay: inflation");
      }
    }
    let current = 0n;
    for (const u of utxos.values()) current += BigInt(u.amount);
    return { utxos, conserved: current <= genesisSum };
  }

  // Verify incremental UTXO equals independent replay.
  verifyConsistency(): { ok: boolean; utxoCount: number; total: string; conserved: boolean } {
    const { utxos, conserved } = this.replayMain();
    const inc = this.store.allUtxos();
    const incMap = new Map(inc.map((u) => [u.txid + ":" + u.vout, u]));
    if (incMap.size !== utxos.size) throw new ChainError(`utxo count mismatch: incremental=${incMap.size} replay=${utxos.size}`);
    for (const [k, u] of utxos) {
      const i = incMap.get(k);
      if (!i || i.amount !== u.amount || i.address !== u.address) {
        throw new ChainError("utxo mismatch at " + k);
      }
    }
    let total = 0n;
    for (const u of utxos.values()) total += BigInt(u.amount);
    return { ok: true, utxoCount: utxos.size, total: total.toString(), conserved };
  }
}

export function hashOfBlock(block: Block): string { return blockHash(block.header); }
export { sha256hex };
