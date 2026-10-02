// 核心数据结构（所有金额均为最小单位整数，内部用 bigint，JSON 中以字符串传输）

export interface TxIn {
  txid: string;      // 引用的前序交易 id
  vout: number;      // 输出序号
  sig: string;       // hex 签名（对 messageToSign 的 Ed25519 签名）
}

export interface TxOut {
  address: string;   // 收款地址 = Ed25519 公钥 hex（64 字节 -> 128 hex）
  value: string;     // 金额（十进制字符串）
}

export interface Transaction {
  txid: string;
  inputs: TxIn[];
  outputs: TxOut[];
}

// 用于签名 / 序列化的交易主体（不含见证签名，避免签名循环）
export interface TxBody {
  inputs: Array<{ txid: string; vout: number }>;
  outputs: TxOut[];
}

export interface Block {
  hash: string;
  height: number;
  prevHash: string;
  timestamp: number;
  target: string;    // 允许集合中的目标值（hex）
  nonce: number;
  txRoot: string;    // 交易 Merkle 根
  txs: Transaction[];
}

export interface GenesisAlloc {
  address: string;
  value: string;
}

export interface BlockHeaderLike {
  height: number;
  prevHash: string;
  timestamp: number;
  target: string;
  nonce: number;
  txRoot: string;
}

export interface ChainTip {
  tipHash: string;
  height: number;
  totalWork: string;
  isMain: boolean;
}

export interface UtxoPoint {
  txid: string;
  vout: number;
}
