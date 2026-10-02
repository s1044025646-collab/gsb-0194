import path from "node:path";

// Allowed proof-of-work targets (decimal strings). Only these may appear in blocks.
const TWO = (n: bigint) => 1n << n;
export const ALLOWED_TARGETS: string[] = [
  (TWO(255n) - 1n).toString(),          // trivially easy (demo default)
  (TWO(248n) - 1n).toString(),
  (TWO(240n) - 1n).toString(),
  (TWO(232n) - 1n).toString(),
];
export const DEFAULT_TARGET = ALLOWED_TARGETS[0];

export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
export const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, "chain.db");
export const PORT = Number(process.env.PORT ?? 8334);

// Fees are destroyed (burned): inputs must cover outputs; the difference is
// removed from circulation and credited to nobody.
export const FEE_POLICY = "burned";

export function workOfTarget(target: bigint): bigint {
  return (1n << 256n) / (target + 1n);
}
