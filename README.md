# Signal（信号）

编辑型科技阅读平台 monorepo。

> 本仓库遵循《Signal 多 Agent 执行规则 v1.0》。
> 基线：Development Contract **v1.1** / Frontend Prototype **v1.7** / UI-UX Spec **v1.7**。

当前状态：**Agent 00（Foundation / 共享契约）已完成**。
仓库骨架、公共包与三个 app 空壳已就绪，业务模块由 Agent 01–14 按波次填充。

## 目录结构

```text
signal/
├─ apps/
│  ├─ web/          Next.js 前台（空壳；真实页面由 Agent 13 按 v1.7 实现）
│  ├─ api/          NestJS API（空壳；模块放 src/modules/<module>/）
│  └─ worker/       NestJS standalone worker（空壳；Job 放 src/jobs/<area>/）
├─ packages/
│  ├─ contracts/    ← 全项目唯一公共 enum / DTO / Queue 名 / Error Code
│  ├─ config/       ← env 校验（严格对齐 docs/20）+ 业务时区工具
│  ├─ logger/       ← Pino JSON + secret 脱敏
│  └─ test-utils/   测试公共工具
├─ prisma/          ← Agent 01 独占（尚未创建）
├─ infra/           ← Agent 11 独占
└─ docs/            ← Agent 00 未创建业务文档，契约见外部开发包
```

## 环境要求

- Node.js **>= 22**（本机验证：v24.14.0）
- pnpm **>= 10**（本机验证：11.15.1）

## 常用命令

| 命令             | 说明                                       |
| ---------------- | ------------------------------------------ |
| `pnpm install`   | 安装依赖                                   |
| `pnpm build`     | `tsc -b`，编译全部 packages + api + worker |
| `pnpm typecheck` | 类型检查（含 web 的 `tsc --noEmit`）       |
| `pnpm lint`      | ESLint                                     |
| `pnpm format`    | Prettier 写入                              |
| `pnpm test`      | Vitest，无需先 build                       |
| `pnpm verify`    | `lint && typecheck && test`                |

启动 app（需先 `pnpm build`）：

```bash
pnpm build
pnpm --filter @signal/api start       # API
pnpm --filter @signal/worker start    # Worker
pnpm --filter @signal/web dev         # Web
```

## 公共契约（Frozen）

以下内容属于冻结契约，普通 Agent **不得**自行修改：

```text
packages/contracts      ← Agent 00 Owner
prisma/schema.prisma    ← Agent 01 Owner
infra / 部署             ← Agent 11 Owner
根 AppModule / Worker 总注册 ← Agent 14 集成时统一完成
```

需要新增枚举值、DTO 字段、API 或数据库字段时，提交 `CONTRACT_CHANGE_REQUEST.md`，
**不要就地改**。

### 唯一枚举来源

`docs/05-enums-state-machines.md` 的全部枚举只在 `@signal/contracts` 定义一次。
测试 `packages/contracts/src/__tests__/no-duplicate-enums.spec.ts` 会静态扫描仓库，
任何 app 内复制 `SourceType` / `ContentPipelineStatus` 等公共类型都会导致 `pnpm test` 失败。

### 关键约定

- API 一律 `/api/v1`，Admin 一律 `/api/v1/admin`。
- 成功：`{ data }`；列表：`{ data, meta: { nextCursor } }`；错误：`{ error: { code, message, requestId, details } }`。
- 数据库 BIGINT 主键在 API 一律序列化为 **string**。
- 业务时区固定 `Asia/Shanghai`；DB 存 UTC。
- 未知错误统一 `INTERNAL_ERROR`，不泄漏内部信息。
- **不存在任何用户订阅能力**（无 `subscriptions` 表 / API / 页面）。

## 环境变量

清单见 `.env.example`，权威来源 `docs/20-environment-variables.md`。
任何 Agent 不得新增未记录的 env；`@signal/config` 的测试会校验 schema 与文档一一对应。
