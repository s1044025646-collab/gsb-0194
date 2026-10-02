export interface TxInput {
  txid: string;
  vout: number;
  pubkey: string;    // hex DER spki
  signature: string; // hex ed25519
}

export interface TxOutput {
  address: string; // hex sha256(pubkey)
  amount: string;  // decimal string (BigInt-safe)
}

export interface Tx {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
}

export interface BlockHeader {
  prev: string;
  height: number;
  time: number;
  target: string; // decimal string
  nonce: number;
  merkle: string;
}

export interface Block {
  header: BlockHeader;
  txs: Tx[];
}

export interface UtxoRec {
  txid: string;
  vout: number;
  address: string;
  amount: string;
}

export interface UndoRec {
  created: Array<{ txid: string; vout: number }>;
  spent: UtxoRec[];
}
