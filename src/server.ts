import http from "node:http";
import { Service } from "./service.js";
import { PORT } from "./config.js";
import { ChainError } from "./chain.js";

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new ChainError("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

export function startServer(service: Service, port: number = PORT): http.Server {
  const server = http.createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj, null, 2));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = req.method === "POST" ? ((await readBody(req)) as Record<string, unknown>) : {};
      const p = url.pathname;

      if (p === "/keygen" && req.method === "POST") {
        // Returns the private key to the caller once; it is never stored or logged.
        return send(200, service.keygen());
      }
      if (p === "/genesis" && req.method === "POST") {
        return send(200, service.createGenesis(body.allocations as never, body.target as string | undefined));
      }
      if (p === "/tx/sign" && req.method === "POST") {
        const tx = service.signTx(body.inputs as never, body.outputs as never, body.privateKey as string);
        return send(200, { tx });
      }
      if (p === "/tx/submit" && req.method === "POST") return send(200, service.submitTx(body.tx as never));
      if (p === "/mine" && req.method === "POST") {
        return send(200, service.mine(body.maxIterations as number | undefined, body.target as string | undefined));
      }
      if (p === "/blocks/import" && req.method === "POST") return send(200, service.importBlock(body.block as never));
      if (p === "/verify" && req.method === "POST") return send(200, service.verify());
      if (p === "/tip" && req.method === "GET") return send(200, service.tip());
      if (p === "/forks" && req.method === "GET") return send(200, service.forks());
      if (p.startsWith("/blocks/") && req.method === "GET") return send(200, service.getBlock(p.slice(8)));
      if (p.startsWith("/tx/") && req.method === "GET") return send(200, service.getTx(p.slice(4)));
      if (p.startsWith("/balance/") && req.method === "GET") return send(200, service.balanceProof(p.slice(9)));
      if (p === "/ancestor" && req.method === "GET") {
        return send(200, service.commonAncestor(url.searchParams.get("a")!, url.searchParams.get("b")!));
      }
      if (p === "/compare" && req.method === "GET") {
        return send(200, service.compareForks(url.searchParams.get("a")!, url.searchParams.get("b")!));
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return send(400, { error: (e as Error).message });
    }
  });
  server.listen(port, () => console.log(`teaching chain API listening on http://127.0.0.1:${port}`));
  return server;
}
