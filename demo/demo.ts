// Demo: two forks, main-chain switch, rolled-back tx query, balance recompute,
// and restart consistency check. Fictional assets only.
import fs from "node:fs";
import path from "node:path";
import { ChainDB } from "../src/db.js";
import { Service } from "../src/service.js";
import { mineBlock } from "../src/miner.js";
import { generateKeyPair, txid } from "../src/crypto.js";
import { DATA_DIR, DB_PATH } from "../src/config.js";
import { Tx } from "../src/types.js";

const EASY = (2n ** 255n - 1n).toString();

function show(title: string, obj: unknown): void {
  console.log("\n=== " + title + " ===");
  console.log(JSON.stringify(obj, null, 2));
}

// fresh start
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const alice = generateKeyPair();
const bob = generateKeyPair();
const carol = generateKeyPair();
console.log("addresses (private keys stay in memory, never logged):");
console.log("  alice:", alice.address);
console.log("  bob:  ", bob.address);
console.log("  carol:", carol.address);

let svc = new Service(new ChainDB(DB_PATH));

// 1. genesis: all assets to alice
const g = svc.createGenesis([{ address: alice.address, amount: "1000" }], EASY);
show("genesis", svc.tip());
const gtx = txid((svc.getBlock(g.hash) as { block: { txs: Tx[] } }).block.txs[0]);

// 2. main branch: alice -> bob 300, change 700 back to alice
const txMain = svc.signTx(
  [{ txid: gtx, vout: 0 }],
  [{ address: bob.address, amount: "300" }, { address: alice.address, amount: "700" }],
  alice.privateKey
);
const mainBlock = mineBlock(g.hash, 1, [txMain], EASY, 50_000_000).block!;
svc.importBlock(mainBlock);
show("after main-branch block (alice->bob)", svc.tip());

// 3. fork branch from genesis: same input, alice -> carol 500 + change 500
const txFork = svc.signTx(
  [{ txid: gtx, vout: 0 }],
  [{ address: carol.address, amount: "500" }, { address: alice.address, amount: "500" }],
  alice.privateKey
);
const forkBlock1 = mineBlock(g.hash, 1, [txFork], EASY, 50_000_000).block!;
const f1 = svc.importBlock(forkBlock1);
show("fork block 1 imported (same coin spent on both branches - legal)", f1);

// 4. extend the fork so it overtakes the main chain -> atomic reorg
const txFork2 = svc.signTx(
  [{ txid: txid(txFork), vout: 1 }],
  [{ address: bob.address, amount: "500" }],
  alice.privateKey
);
const forkBlock2 = mineBlock(f1.hash, 2, [txFork2], EASY, 50_000_000).block!;
svc.importBlock(forkBlock2);
show("after fork overtakes (reorg done)", svc.tip());
show("all known branches", svc.forks());

// 5. rolled-back tx is still queryable, marked as side branch
show("rolled-back tx alice->bob", svc.getTx(txid(txMain)));

// 6. recomputed balances with UTXO proof detail
show("balance alice", svc.balanceProof(alice.address));
show("balance bob", svc.balanceProof(bob.address));
show("balance carol", svc.balanceProof(carol.address));

// 7. full replay verification
show("verify (replay == incremental UTXO, conservation)", svc.verify());
svc.store.close();

// 8. restart: reopen the same DB file and confirm tip + UTXO consistency
console.log("\n--- restarting (reopening " + DB_PATH + ") ---");
svc = new Service(new ChainDB(DB_PATH));
show("tip after restart", svc.tip());
show("verify after restart", svc.verify());
svc.store.close();
console.log("\ndemo finished OK");
