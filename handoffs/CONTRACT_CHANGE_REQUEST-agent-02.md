# Contract Change Request

Agent: **02 — Auth / Users**
Module: `apps/api/src/modules/auth`、`apps/api/src/modules/users`
日期: 2026-09-23
规则依据: 《Signal 多 Agent 执行规则 v1.0》§6 / §7

> 三项请求**都不阻塞**当前交付：Agent 02 已按现有契约完成实现并全绿。
> 它们是「后续更合理」的调整，请公共 Owner 决定。

---

## CCR-02-1 — 把 Auth / Me 的响应 DTO 提升到 `packages/contracts`

### Current Problem

`docs/18` 规定「跨 app 的 DTO 在 `packages/contracts`」，但契约包里目前只有
`dto/public.ts`（PublicSource / PublicContent / ...），**没有任何 Auth / 用户身份相关的 DTO**。

Agent 02 的响应体因此只能落在模块内：

```ts
// apps/api/src/modules/users/dto/me.dto.ts
export type MeDto = { id; email; displayName; avatarUrl; role; createdAt };
// apps/api/src/modules/auth/dto/auth.dto.ts
export type AuthSessionResponse = { user: MeDto; accessTokenExpiresInSeconds: number };
```

而 `packages/contracts` 是 Agent 00 的冻结区，Agent 02 不得就地新增类型
（`docs/06` / `docs/18`），所以只能先放模块内。

### Requested Change

在 `packages/contracts/src/dto/` 下新增（建议 `auth.ts`）：

```ts
export type MeDto = {
  id: BigIntId;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: UserRole;
  createdAt: IsoDateTimeString;
};

export type RequestCodeResponse = { sent: true; expiresInSeconds: number };
export type AuthSessionResponse = { user: MeDto; accessTokenExpiresInSeconds: number };
export type LogoutResponse = { loggedOut: true };
```

Agent 02 把模块内 DTO 改为 re-export，**不改变任何对外 JSON**。

### Reason

Agent 09（偏好）、Agent 12（Admin UI）、Agent 13（Public Web）都要复用同一个
「当前用户」结构。目前它们只能各自复制一份 `MeDto`，会重演
`no-duplicate-enums` 守卫要防的那类漂移。

### Compatibility

不影响任何已有取值；纯新增。对外 JSON 逐字不变。

### Database Impact

无。

### API Impact

无（同样的响应字段与形状）。

### Downstream Impact

Agent 09 / 12 / 13 受益；其余无感。

---

## CCR-02-2 — `PlatformErrorCode` 增加 `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE`

### Current Problem

Express / body-parser 抛的 `PayloadTooLargeError` 带 `status = 413`，但**不是** Nest 的
`HttpException`。`docs/05` 的 Error Code 规则（`DOMAIN_REASON`）与 Agent 00 的
`PlatformErrorCode` 都没有对应取值，于是它会被降级成 `INTERNAL_ERROR`（500）——
把「客户端发了超大请求体」报成服务端故障，并污染 5xx 告警。

Agent 02 已在 `AppErrorFilter` 里识别 `err.status` 并**返回正确的 413**，
但 `code` 只能临时复用 `VALIDATION_FAILED`（`docs/05` 禁止同义码，
而 Agent 02 无权往平台注册表加值）。

### Requested Change

`packages/contracts/src/errors.ts` 的 `PlatformErrorCode` 增加：

```ts
PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',        // 413
UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE', // 415（同为 body-parser 常见错）
```

并在 `PLATFORM_ERROR_HTTP_STATUS` 里映射到 413 / 415。

### Reason

413 是**客户端错误**，复用 `VALIDATION_FAILED` 语义不准；且 `docs/15` 依赖 5xx 率告警。

### Compatibility

纯新增，无既有取值变动。既有测试（`errors.spec.ts`）应仍全绿。

### Database Impact

无。

### API Impact

413 / 415 响应的 `error.code` 从 `VALIDATION_FAILED` 变为专用码
（**仅这两种状态码**，且它们此前是 500）。属可接受的修正。

### Downstream Impact

所有上传/大 body 的模块受益（Agent 07 / 11）。

---

## CCR-02-3 — 明确「X-Forwarded-For 的信任边界」写入部署契约

### Current Problem

`docs/16-deployment-backup.md` 只写了「nginx 反代」，**没有规定 XFF 的写法**。
而 per-IP 限流依赖它。独立审查实测：按「取 XFF 第一段」实现时，
客户端伪造 `X-Forwarded-For: <任意值>` 即可完全绕过 per-IP 限流（30/30 放行）。

Agent 02 已改为取 **最后一段**（最后一跳代理看到的对端），在
`$proxy_add_x_forwarded_for`（追加）与 `$remote_addr`（覆盖）两种 nginx 写法下都不可伪造，
因此**不需要 nginx 侧的特殊配合**。

但仍有一个前提必须写进部署契约：**api 端口不得直接对公网暴露**。
若直连（无代理），XFF 完全由客户端自填，末段同样可伪造。

### Requested Change

`docs/16` 增加一条部署要求（并同步到 Agent 11 的部署脚本 / nginx 模板）：

```text
- api 只监听内网/回环，仅 nginx 可访问；安全组不得放行 api 端口。
- nginx 反代时 `proxy_set_header X-Forwarded-For` 可为 $proxy_add_x_forwarded_for
  或 $remote_addr（两者都安全）；**不要**原样透传且不做任何处理。
```

### Reason

这是限流有效性的**部署侧前提**，不在代码里，只能靠契约约束。

### Compatibility

纯文档补充。

### Database Impact / API Impact

无。

### Downstream Impact

Agent 11（Ops）、Agent 14（集成）。
