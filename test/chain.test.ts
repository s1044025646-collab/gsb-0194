import test from "node:test";
import assert from "node:assert/strict";
import { ChainDB } from "../src/db.js";
import { Service } from "../src/service.js";
import { Chain, setReorgFailHook, hashOfBlock } from "../src/chain.js";
import { mineBlock } from "../src/miner.js";
import { generateKeyPair } from "../src/crypto.js";
import { txid } from "../src/crypto.js";
import { Tx, Block } from "../src/types.js";

const EASY = (2n ** 255n - 1n).toString();     // ~2 work per block
const HARD = (2n ** 248n - 1n).toString();     // ~256 work per block

function freshService(): Service {
  return new Service(new ChainDB(":memory:"));
}

function setup(): { svc: Service; alice: ReturnType<typeof generateKeyPair>; bob: ReturnType<typeof generateKeyPair>; carol: ReturnType<typeof generateKeyPair>; genesisTx: string } {
  const svc = freshService();
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const carol = generateKeyPair();
  const { hash } = svc.createGenesis([{ address: alice.address, amount: "1000" }], EASY);
  const row = svc.store.getBlock(hash)!;
  const genesisTx = txid((JSON.parse(row.txs) as Tx[])[0]);
  return { svc, alice, bob, carol, genesisTx };
}

function mineOn(svc: Service, prevHash: string, txs: Tx[], target = EASY): { hash: string; block: Block } {
  const prev = svc.store.getBlock(prevHash)!;
  const res = mineBlock(prevHash, prev.height + 1, txs, target, 50_000_000);
  assert.ok(res.block, "mining budget exhausted");
  const acc = svc.importBlock(res.block!);
  return { hash: acc.hash, block: res.block! };
}

test("forged signature is rejected", () => {
  const { svc, alice, bob, genesisTx } = setup();
  const tx = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: bob.address, amount: "1000" }], alice.privateKey);
  tx.inputs[0].signature = tx.inputs[0].signature.replace(/.$/, tx.inputs[0].signature.endsWith("0") ? "1" : "0");
  assert.throws(() => svc.submitTx(tx), /bad signature/);
});

test("duplicate inputs inside one tx are rejected", () => {
  const { svc, alice, bob, genesisTx } = setup();
  const tx = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: bob.address, amount: "1000" }], alice.privateKey);
  tx.inputs.push({ ...tx.inputs[0] });
  assert.throws(() => svc.submitTx(tx), /duplicate input/);
});

test("negative and overflowing outputs are rejected", () => {
  const { svc, alice, bob, genesisTx } = setup();
  // outputs exceeding inputs are caught when the block connects
  const tx = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: bob.address, amount: "1001" }], alice.privateKey);
  svc.submitTx(tx);
  assert.throws(() => svc.mine(), /inputs do not cover outputs/);
  // malformed amount encoding is caught structurally
  const bad = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: bob.address, amount: "1000" }], alice.privateKey);
  bad.outputs[0].amount = "-5";
  assert.throws(() => svc.submitTx(bad), /invalid amount|negative/);
});

test("in-block double spend is rejected and chain state is untouched", () => {
  const { svc, alice, bob, carol, genesisTx } = setup();
  const tx1 = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: bob.address, amount: "1000" }], alice.privateKey);
  const tx2 = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: carol.address, amount: "1000" }], alice.privateKey);
  const tip = (svc.tip() as { hash: string }).hash;
  const prev = svc.store.getBlock(tip)!;
  const res = mineBlock(tip, prev.height + 1, [tx1, tx2], EASY, 50_000_000);
  assert.ok(res.block);
  assert.throws(() => svc.importBlock(res.block!), /in-block double spend/);
  assert.equal((svc.tip() as { hash: string }).hash, tip);
  assert.equal((svc.balanceProof(alice.address) as { balance: string }).balance, "1000");
});

test("orphan block waits, then connects when parent arrives", () => {
  const { svc, alice, bob, genesisTx } = setup();
  const tip = (svc.tip() as { hash: string }).hash;
  const tx1 = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: bob.address, amount: "400" }, { address: alice.address, amount: "600" }], alice.privateKey);
  const b1 = mineOn(svc, tip, [tx1]);
  // fresh chain that only knows the same genesis block
  const svc2 = freshService();
  const genesisRow = svc.store.getBlock(tip)!;
  svc2.importBlock(svc.store.blockFromRow(genesisRow));
  // mine b2 on top of b1 in svc, then import b2 into svc2 before its parent b1
  const b1row = svc.store.getBlock(b1.hash)!;
  const utxoB = txid(tx1);
  const tx2 = svc.signTx([{ txid: utxoB, vout: 1 }], [{ address: bob.address, amount: "600" }], alice.privateKey);
  const res2 = mineBlock(b1.hash, b1row.height + 1, [tx2], EASY, 50_000_000);
  const acc = svc2.importBlock(res2.block!);
  assert.equal(acc.status, "orphan");
  // now import b1 -> orphan b2 should attach and become main (more work)
  const acc1 = svc2.importBlock(b1.block);
  assert.equal(acc1.status, "main");
  const tip2 = svc2.tip() as { hash: string };
  assert.equal(tip2.hash, acc.hash);
});

test("equal height, different work: higher-work branch wins", () => {
  const { svc, alice, bob, carol, genesisTx } = setup();
  const tip = (svc.tip() as { hash: string }).hash;
  const txA = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: bob.address, amount: "1000" }], alice.privateKey);
  const easy = mineOn(svc, tip, [txA], EASY);
  assert.equal((svc.tip() as { hash: string }).hash, easy.hash);
  // competing block at same height with much harder target
  const txB = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: carol.address, amount: "1000" }], alice.privateKey);
  const hard = mineOn(svc, tip, [txB], HARD);
  assert.equal((svc.tip() as { hash: string }).hash, hard.hash, "harder block must win despite equal height");
  const bal = svc.balanceProof(carol.address) as { balance: string };
  assert.equal(bal.balance, "1000");
});

test("same output spent on both sides of a fork is legal per-branch", () => {
  const { svc, alice, bob, carol, genesisTx } = setup();
  const tip = (svc.tip() as { hash: string }).hash;
  const txMain = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: bob.address, amount: "1000" }], alice.privateKey);
  const main1 = mineOn(svc, tip, [txMain]);
  // fork from genesis: same input to carol
  const txFork = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: carol.address, amount: "1000" }], alice.privateKey);
  const fork1 = mineOn(svc, tip, [txFork]);
  const forkStatus = svc.store.getBlock(fork1.hash)!.status;
  assert.ok(forkStatus === "side" || forkStatus === "main");
  // extend fork so it overtakes
  const fork1row = svc.store.getBlock(fork1.hash)!;
  void fork1row;
  const txidFork = txid(txFork);
  const txFork2 = svc.signTx([{ txid: txidFork, vout: 0 }], [{ address: alice.address, amount: "1000" }], carol.privateKey);
  const fork2 = mineOn(svc, fork1.hash, [txFork2]);
  assert.equal((svc.tip() as { hash: string }).hash, fork2.hash);
  // rolled-back tx still queryable, marked as side branch
  const info = svc.getTx(txid(txMain)) as { branchStatus: string };
  assert.equal(info.branchStatus, "side");
  assert.equal((svc.balanceProof(bob.address) as { balance: string }).balance, "0");
  assert.equal((svc.balanceProof(alice.address) as { balance: string }).balance, "1000");
  const v = svc.verify() as { ok: boolean; conserved: boolean };
  assert.ok(v.ok && v.conserved);
});

test("replay of selected main chain matches incremental UTXO and conserves value", () => {
  const { svc, alice, bob, genesisTx } = setup();
  const tip = (svc.tip() as { hash: string }).hash;
  const tx1 = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: bob.address, amount: "300" }, { address: alice.address, amount: "690" }], alice.privateKey);
  // fee 10 burned
  svc.submitTx(tx1);
  svc.mine();
  const v = svc.verify() as { ok: boolean; total: string; conserved: boolean };
  assert.ok(v.ok);
  assert.ok(v.conserved);
  assert.equal(v.total, "990"); // 10 burned as fee
});

test("injected mid-reorg failure rolls back atomically", () => {
  const { svc, alice, bob, carol, genesisTx } = setup();
  const tip = (svc.tip() as { hash: string }).hash;
  const txMain = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: bob.address, amount: "1000" }], alice.privateKey);
  mineOn(svc, tip, [txMain]);

  const txFork = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: carol.address, amount: "1000" }], alice.privateKey);
  const f1res = mineBlock(tip, 1, [txFork], EASY, 50_000_000).block!;
  const f1hash = hashOfBlock(f1res);
  svc.importBlock(f1res); // competing branch at height 1

  // snapshot state right before the reorg-triggering block
  const tipBefore = (svc.tip() as { hash: string }).hash;
  const utxoBefore = svc.store.allUtxos();

  const txFork2 = svc.signTx([{ txid: txid(txFork), vout: 0 }], [{ address: alice.address, amount: "1000" }], carol.privateKey);
  const r2 = mineBlock(f1hash, 2, [txFork2], EASY, 50_000_000);

  setReorgFailHook((phase) => { if (phase === "connect") throw new Error("injected reorg failure"); });
  assert.throws(() => svc.importBlock(r2.block!), /injected reorg failure/);
  setReorgFailHook(null);

  // nothing changed: tip, utxo, undo all intact
  assert.equal((svc.tip() as { hash: string }).hash, tipBefore);
  assert.deepEqual(svc.store.allUtxos(), utxoBefore);
  const v = svc.verify() as { ok: boolean };
  assert.ok(v.ok);

  // retry without the hook: reorg now succeeds and the fork branch wins
  svc.importBlock(r2.block!);
  assert.equal((svc.tip() as { hash: string; height: number }).height, 2);
  assert.equal((svc.tip() as { hash: string }).hash, hashOfBlock(r2.block!));
  assert.equal((svc.balanceProof(alice.address) as { balance: string }).balance, "1000");
});

test("chain selection tie-break is deterministic (lowest hash wins)", () => {
  const { svc, alice, bob, carol, genesisTx } = setup();
  const tip = (svc.tip() as { hash: string }).hash;
  const txA = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: bob.address, amount: "1000" }], alice.privateKey);
  const txB = svc.signTx([{ txid: genesisTx, vout: 0 }], [{ address: carol.address, amount: "1000" }], alice.privateKey);
  const a = mineOn(svc, tip, [txA]);
  const b = mineOn(svc, tip, [txB]);
  const expected = [a.hash, b.hash].sort()[0];
  assert.equal((svc.tip() as { hash: string }).hash, expected);
});
