import { ChainDB } from "./db.js";
import { Service } from "./service.js";
import { startServer } from "./server.js";
import { PORT } from "./config.js";
import fs from "node:fs";

function out(obj: unknown): void { console.log(JSON.stringify(obj, null, 2)); }

function usage(): void {
  console.log(`teaching-utxo-chain CLI (fictional assets, local only)
usage: node dist/src/cli.js <command> [args]

  serve                              start HTTP API (PORT env, default 8334)
  keygen                             generate ed25519 keypair (private key shown once, never stored)
  genesis '<json allocations>' [target]   create genesis block, e.g. '[{"address":"...","amount":"1000"}]'
  sign '<inputs json>' '<outputs json>' <privateKey>   sign a transaction
  submit '<tx json>'                 submit signed tx to mempool
  mine [maxIterations] [target]      mine a block on current tip with mempool txs
  import <blockFile.json>            import a block (fork or orphan)
  block <hash>                       show block
  tx <txid>                          find transaction (any branch)
  tip                                show main chain tip
  forks                              list all known blocks/branches
  ancestor <hashA> <hashB>           common ancestor
  compare <hashA> <hashB>            compare two branches
  balance <address>                  balance proof with UTXO detail
  verify                             replay main chain, check UTXO consistency & conservation
`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help") return usage();
  const service = new Service(new ChainDB());

  switch (cmd) {
    case "serve": startServer(service, Number(args[0] ?? PORT)); break;
    case "keygen": out(service.keygen()); break;
    case "genesis": out(service.createGenesis(JSON.parse(args[0]), args[1])); break;
    case "sign": out({ tx: service.signTx(JSON.parse(args[0]), JSON.parse(args[1]), args[2]) }); break;
    case "submit": out(service.submitTx(JSON.parse(args[0]))); break;
    case "mine": out(service.mine(args[0] ? Number(args[0]) : undefined, args[1])); break;
    case "import": out(service.importBlock(JSON.parse(fs.readFileSync(args[0], "utf8")))); break;
    case "block": out(service.getBlock(args[0])); break;
    case "tx": out(service.getTx(args[0])); break;
    case "tip": out(service.tip()); break;
    case "forks": out(service.forks()); break;
    case "ancestor": out(service.commonAncestor(args[0], args[1])); break;
    case "compare": out(service.compareForks(args[0], args[1])); break;
    case "balance": out(service.balanceProof(args[0])); break;
    case "verify": out(service.verify()); break;
    default: usage();
  }
  if (cmd !== "serve") service.store.close();
}

main().catch((e) => { console.error("error:", e.message); process.exit(1); });
