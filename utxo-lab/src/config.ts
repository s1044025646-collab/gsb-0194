import path from "node:path";

// 固定允许的区块目标集合（教学难度，均为虚构网络）。
// 目标值为 256 位上限：blockHash（视为大整数）必须 <= target。
// EASY 约 2^252，平均约 16 次哈希即可出块，适合课堂演示。
export const ALLOWED_TARGETS: Record<string, string> = {
  EASY: "0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  MEDIUM: "00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  HARD: "000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
};

export const DEFAULT_TARGET = ALLOWED_TARGETS.EASY;

export interface AppConfig {
  port: number;
  dataDir: string;
  dbFile: string;
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.UTXO_DATA_DIR ?? path.join(process.cwd(), "data"));
  const port = Number(process.env.PORT ?? process.env.UTXO_PORT ?? 8787);
  return { port, dataDir, dbFile: path.join(dataDir, "utxo-lab.sqlite") };
}
