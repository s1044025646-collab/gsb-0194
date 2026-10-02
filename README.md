# 教学用 UTXO 分叉链验证与原子重组后端

纯本地、纯教学用途的区块链验证实验服务。所有资产均为**虚构**，不连接任何真实网络、
不使用真实资金、无节点发现、无共识通信。仅提供 HTTP API 与 CLI 两种接口。

- 技术栈：TypeScript + Node.js（>= 22，推荐 25）+ SQLite（Node 内置 `node:sqlite`，无原生编译依赖）
- 平台：Windows 本地运行，不依赖 Docker / WSL / 付费服务 / 外部在线 API
- 金额：最小单位整数，全程以 BigInt 处理，SQLite 中以十进制字符串存储
- 签名：Node 内置 Ed25519（`node:crypto`）

## 快速开始

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 HTTP API（默认端口 8334，可用 PORT 环境变量覆盖）
npm run demo       # 完整演示：分叉、重组、回滚交易查询、余额重算、重启一致性
```

CLI 直接使用：`npm run cli -- <命令>`，例如 `npm run cli -- tip`。
数据目录默认为项目内 `data/`（可用 `DATA_DIR` / `DB_PATH` 环境变量覆盖）。

## 核心设计

### 确定性序列化与摘要
- 所有摘要前使用规范化 JSON（对象键排序、BigInt 转字符串），见 `src/crypto.ts` 的 `canonical`。
- `txid = sha256(canonical(tx))`；区块头包含 `prev/height/time/target/nonce/merkle`，
  `blockHash = sha256(canonical(header))`；默克尔树对 txid 列表逐层配对哈希。
- 每个输入签名的消息为「清空全部签名后的 txid + 输入下标」的 sha256（`sighash`）。

### 工作量与链选择
- 区块目标值只能取自固定允许集合（`src/config.ts` 的 `ALLOWED_TARGETS`），否则拒绝。
- 实际摘要必须满足 `hash <= target`。
- 每块工作量 `work = 2^256 / (target + 1)`，链选择按**精确累计工作量**（BigInt）最大者；
  平局时取**区块哈希最小者**（确定性规则），绝不只看高度。

### 交易与 UTXO 验证
- 输出金额非负且为合法十进制编码；同一交易内输入不得重复。
- 签名所有权：`sha256(pubkey)` 必须等于被引用输出的地址。
- 输入总额必须覆盖输出总额；**手续费 = 输入 - 输出，直接销毁（burned）**，不归属任何人
  （`FEE_POLICY = "burned"`，余额证明接口会返回该口径）。
- 同区块交易按区块内公开顺序依次验证；同一块内重复消费同一输出即「块内双花」，拒绝。
- 分叉上的消费只在该分叉被选中为主链时才按当时 UTXO 状态验证，因此「另一条分叉上合法的
  消费」不会被当前主链状态误判为双花。
- 创世块包含唯一一笔无输入交易，给出全部初始资产；无区块奖励。

### 分叉、孤块与原子重组
- 缺父块的区块进入 `orphan` 待连接状态，绝不并入主链；父块到达后自动重试连接。
- 每个连接进主链的区块都记录可撤销的 UTXO 变更（`undo` 表：新创输出 + 被花费输出的完整快照）。
- 重组 = 从公共祖先回退旧分支（逆向应用 undo）再应用新分支，**全部在一个 SQLite 事务内**完成；
  任何区块验证失败或注入的中途错误都会整体回滚，不留半重组状态。
- 历史区块与被替换分支永久保留（`side` 状态），可随时查询，包括被回退的交易。
- 提供独立重放校验：从创世重放当前主链得到的 UTXO 集合必须与增量维护的 UTXO 完全一致，
  且总额不超过创世发行额（金额守恒，差额即已销毁手续费）。

### 私钥处理
`/keygen` 与 CLI `keygen` 生成的私钥**仅当场返回给调用方一次**，服务端与 CLI 均不存储、
不记录日志；任何查询接口都不会返回私钥。

## HTTP API（默认 `http://127.0.0.1:8334`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/keygen` | 生成 Ed25519 密钥对（私钥仅本次返回） |
| POST | `/genesis` | 建创世块：`{"allocations":[{"address","amount"}], "target"?}` |
| POST | `/tx/sign` | 签名交易：`{"inputs":[{"txid","vout"}], "outputs":[...], "privateKey"}` |
| POST | `/tx/submit` | 提交已签名交易到 mempool：`{"tx": {...}}` |
| POST | `/mine` | 有限预算教学挖块：`{"maxIterations"?, "target"?}`，打包 mempool |
| POST | `/blocks/import` | 导入区块（分叉或孤块）：`{"block": {...}}` |
| POST | `/verify` | 重放主链并校验 UTXO 一致性与金额守恒 |
| GET  | `/tip` | 当前主链头（哈希/高度/累计工作量） |
| GET  | `/forks` | 所有已知区块及分支状态 |
| GET  | `/blocks/:hash` | 查询任意分支的区块 |
| GET  | `/tx/:txid` | 查询交易（含被回退分支上的交易） |
| GET  | `/balance/:address` | 余额证明明细（UTXO 列表 + 手续费口径） |
| GET  | `/ancestor?a=&b=` | 两块的公共祖先 |
| GET  | `/compare?a=&b=` | 分叉比较（各自累计工作量、公共祖先、当前选中链头、平局规则） |

## CLI 命令

```
node dist/src/cli.js serve [port]            启动 API
node dist/src/cli.js keygen                  生成密钥对
node dist/src/cli.js genesis '<json>' [target]
node dist/src/cli.js sign '<inputs>' '<outputs>' <privateKey>
node dist/src/cli.js submit '<tx json>'
node dist/src/cli.js mine [maxIterations] [target]
node dist/src/cli.js import <blockFile.json>
node dist/src/cli.js block <hash> | tx <txid> | tip | forks
node dist/src/cli.js ancestor <a> <b> | compare <a> <b>
node dist/src/cli.js balance <address> | verify
```

## 测试覆盖（`test/chain.test.ts`，共 10 项）

伪造签名、交易内重复输入、负/溢出输出、块内双花、孤块后补接入、等高度不同工作量分支、
共同祖先两侧各自花费同一输出的合法分叉、重放与增量 UTXO 一致性及金额守恒、
注入重组中途失败验证事务回滚、平局确定性规则。

## 已知限制（教学定位）

- 无网络层、无 mempool 传播、无持久化密钥管理；挖矿为单线程有限预算教学实现。
- 重组失败的非法分叉块保留为 `side` 状态并记录，再次触发重组时仍会失败（不会污染主链）。
- 难度不做动态调整，目标值仅允许固定集合。
