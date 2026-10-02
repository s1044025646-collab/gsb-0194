import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { DB_PATH, DATA_DIR } from "./config.js";
import { Block, UtxoRec, UndoRec } from "./types.js";

export interface BlockRow {
  hash: string;
  prev: string;
  height: number;
  time: number;
  target: string;
  nonce: number;
  merkle: string;
  txs: string;
  cumwork: string | null;
  status: string; // main | side | orphan | invalid
  received: number;
}

export class ChainDB {
  db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS blocks(
        hash TEXT PRIMARY KEY,
        prev TEXT NOT NULL,
        height INTEGER NOT NULL,
        time INTEGER NOT NULL,
        target TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        merkle TEXT NOT NULL,
        txs TEXT NOT NULL,
        cumwork TEXT,
        status TEXT NOT NULL,
        received INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS utxo(
        txid TEXT NOT NULL,
        vout INTEGER NOT NULL,
        address TEXT NOT NULL,
        amount TEXT NOT NULL,
        PRIMARY KEY(txid, vout)
      );
      CREATE TABLE IF NOT EXISTS undo(
        block_hash TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mempool(
        txid TEXT PRIMARY KEY,
        tx TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta(
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  close(): void { this.db.close(); }

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  getBlock(hash: string): BlockRow | null {
    const r = this.db.prepare("SELECT * FROM blocks WHERE hash=?").get(hash) as BlockRow | undefined;
    return r ?? null;
  }
  hasBlock(hash: string): boolean { return this.getBlock(hash) !== null; }

  insertBlock(hash: string, block: Block, cumwork: string | null, status: string): void {
    const h = block.header;
    this.db.prepare(
      "INSERT INTO blocks(hash,prev,height,time,target,nonce,merkle,txs,cumwork,status,received) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    ).run(hash, h.prev, h.height, h.time, h.target, h.nonce, h.merkle, JSON.stringify(block.txs), cumwork, status, Date.now());
  }

  setBlockStatus(hash: string, status: string, cumwork?: string): void {
    if (cumwork !== undefined) this.db.prepare("UPDATE blocks SET status=?, cumwork=? WHERE hash=?").run(status, cumwork, hash);
    else this.db.prepare("UPDATE blocks SET status=? WHERE hash=?").run(status, hash);
  }

  blocksByStatus(status: string): BlockRow[] {
    return this.db.prepare("SELECT * FROM blocks WHERE status=?").all(status) as unknown as BlockRow[];
  }
  allBlocks(): BlockRow[] { return this.db.prepare("SELECT * FROM blocks").all() as unknown as BlockRow[]; }
  orphansOf(prev: string): BlockRow[] {
    return this.db.prepare("SELECT * FROM blocks WHERE status='orphan' AND prev=?").all(prev) as unknown as BlockRow[];
  }

  blockFromRow(row: BlockRow): Block {
    return {
      header: { prev: row.prev, height: row.height, time: row.time, target: row.target, nonce: row.nonce, merkle: row.merkle },
      txs: JSON.parse(row.txs),
    };
  }

  // --- UTXO (current main-chain view) ---
  getUtxo(txid: string, vout: number): UtxoRec | null {
    const r = this.db.prepare("SELECT * FROM utxo WHERE txid=? AND vout=?").get(txid, vout) as UtxoRec | undefined;
    return r ?? null;
  }
  addUtxo(u: UtxoRec): void {
    this.db.prepare("INSERT INTO utxo(txid,vout,address,amount) VALUES(?,?,?,?)").run(u.txid, u.vout, u.address, u.amount);
  }
  delUtxo(txid: string, vout: number): void {
    this.db.prepare("DELETE FROM utxo WHERE txid=? AND vout=?").run(txid, vout);
  }
  allUtxos(): UtxoRec[] { return this.db.prepare("SELECT * FROM utxo ORDER BY txid, vout").all() as unknown as UtxoRec[]; }
  utxosOf(address: string): UtxoRec[] {
    return this.db.prepare("SELECT * FROM utxo WHERE address=? ORDER BY txid, vout").all(address) as unknown as UtxoRec[];
  }

  setUndo(blockHash: string, undo: UndoRec): void {
    this.db.prepare("INSERT OR REPLACE INTO undo(block_hash,data) VALUES(?,?)").run(blockHash, JSON.stringify(undo));
  }
  getUndo(blockHash: string): UndoRec | null {
    const r = this.db.prepare("SELECT data FROM undo WHERE block_hash=?").get(blockHash) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  delUndo(blockHash: string): void { this.db.prepare("DELETE FROM undo WHERE block_hash=?").run(blockHash); }

  mempoolAdd(txidHex: string, txJson: string): void {
    this.db.prepare("INSERT OR REPLACE INTO mempool(txid,tx) VALUES(?,?)").run(txidHex, txJson);
  }
  mempoolDel(txidHex: string): void { this.db.prepare("DELETE FROM mempool WHERE txid=?").run(txidHex); }
  mempoolAll(): Array<{ txid: string; tx: string }> {
    return this.db.prepare("SELECT * FROM mempool").all() as unknown as Array<{ txid: string; tx: string }>;
  }
}
