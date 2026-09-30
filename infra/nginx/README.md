# Nginx 与 TLS 证书

`docker-compose.yml` 的 `nginx` 服务把 `infra/nginx/nginx.conf` 挂进去，
并把**宿主机目录** `infra/nginx/certs/` 挂到容器内的 `/etc/nginx/certs/`。

`nginx.conf` 里写死了这两个文件名：

```text
/etc/nginx/certs/fullchain.pem     证书链
/etc/nginx/certs/privkey.pem       私钥
```

所以**宿主机上必须有这两个文件**，否则 nginx 起不来 —— 见下面的「首次部署」。
`infra/nginx/certs/` 不进版本库（`privkey.pem` 是私钥）。

---

## 首次部署（新机器）

### ⚠ 先说清楚那个「先有鸡还是先有蛋」

`docker compose up` 在**证书还不存在**的机器上会失败：

```text
nginx: [emerg] cannot load certificate "/etc/nginx/certs/fullchain.pem"
→ nginx 容器启动失败 → 它的 healthcheck（`nginx -t`）永远不通过 → 反复重启
```

而签发证书又需要一个能对外提供 `/.well-known/acme-challenge/` 的 80 端口 ——
那正是 nginx 提供的。**先放一份自签证书占位**就解开了这个环。

### 步骤

**0. DNS 先生效。** 把域名的 A / AAAA 记录指向这台 VPS，并且确认
**公网能访问 80 端口**（Let's Encrypt 的验证是从外网发起的，
本地 curl 通不算数）。

**1. 填 `.env`**

```bash
cp .env.example .env      # 填好 MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD / 各类 secret
```

**2. 自签一张临时证书**（只为让 nginx 起来，1 天后过期，用完会被覆盖）

```bash
mkdir -p infra/nginx/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout infra/nginx/certs/privkey.pem \
  -out    infra/nginx/certs/fullchain.pem \
  -subj "/CN=signal.local"
```

**3. 起整栈**

```bash
docker compose up -d --build
docker compose ps        # 全部 (healthy) 才算起来
```

**4. 用 webroot 方式签发真证书**

80 端口此刻由 nginx 提供，challenge 目录是 compose 里的具名卷
`certbot-webroot`（compose 的 `name: signal` 决定了它在宿主上叫
`signal_certbot-webroot`）。

```bash
DOMAIN=signal.example.com
EMAIL=ops@example.com

docker run --rm \
  -v signal_certbot-webroot:/var/www/certbot \
  -v "$PWD/infra/letsencrypt:/etc/letsencrypt" \
  -v "$PWD/infra/nginx/certs:/certs" \
  certbot/certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" --agree-tos -m "$EMAIL" --no-eff-email \
    --deploy-hook "install -m 644 /etc/letsencrypt/live/$DOMAIN/fullchain.pem /certs/fullchain.pem && \
                   install -m 600 /etc/letsencrypt/live/$DOMAIN/privkey.pem   /certs/privkey.pem"
```

**5. 让 nginx 读上新证书**

`infra/nginx/certs/` 是 bind mount，宿主机上的文件一换，容器里就是新的：

```bash
docker compose exec nginx nginx -s reload
curl -sS https://$DOMAIN/health/ready      # 期望 200
```

**6. 删掉自签证书的痕迹**（第 4 步已经覆盖了这两个文件）

```bash
ls -l infra/nginx/certs/     # 确认时间戳是刚才那一次
```

---

## 续期

Let's Encrypt 的证书有效期 90 天。用 **webroot** 续期**不需要停 nginx**
（challenge 由 nginx 自己提供）。

`crontab -e`，加两条（时间带随机偏移是 Let's Encrypt 官方建议：

```cron
17 3,15 * * * cd /srv/signal && /srv/signal/scripts/ops/renew-cert.sh signal.example.com >> /var/log/signal-cert.log 2>&1
```

⚠ 仓库里**没有** `scripts/ops/renew-cert.sh` —— 续期脚本需要写域名与邮箱，
那是每台机器自己的信息，不适合进版本库。上面那行 cron 里的路径是示例，
请把它替换成你实际放在机器上的脚本（内容就是第 4 步那条 `docker run`，
去掉 `--agree-tos -m`，换成 `certbot renew`）。

**续期成功不等于 nginx 用上了新证书** —— `certbot renew` 只在快到期时才会
真的签发，`install` 那一步写在 `--deploy-hook` 里所以会跟着跑；
但 `nginx -s reload` 必须自己触发：

```bash
docker compose exec nginx nginx -s reload
```

把这两步串在同一个脚本里，避免「证书续了、nginx 还在用旧的，
90 天后整站证书过期」。

---

## 排查

| 现象                                        | 原因                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| nginx 容器反复重启，日志是 `cannot load certificate` | `infra/nginx/certs/` 里没有那两个文件 → 回到「首次部署」第 2 步      |
| `docker compose ps` 里 nginx 一直 `starting` | `nginx -t` 没过。`docker compose exec nginx nginx -t` 看具体哪一行   |
| 证书签不下来，报 `Timeout during connect`    | 80 端口从公网不可达（安全组 / 防火墙 / DNS 还没生效）                |
| `https` 能开但 `http` 不跳转                 | 正常：80 那个 server 只服务 ACME challenge 与 301，业务全走 443      |
| 前台登录后立刻掉登录态                        | 大概率是跨域了。`docs/16` 要求**同域**（`/` 与 `/api/` 同一个域名）  |
