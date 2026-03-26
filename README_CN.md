# ReForward

ReForward 是一个基于 Cloudflare Worker 的反向代理控制台，现在以首跑 OOBE 作为主流程。

全新部署后，访问任意路径都会先进入初始化页面。OOBE 会把后台路径、默认入口策略和后台密码哈希写入 D1。初始化一旦完成，OOBE 就会永久锁定，后续请求都走正式路由逻辑。

## 功能概览

- 公开路由支持 `proxy`、`site`、`redirect`、`text`
- 后台路径保存在 D1，不再写死在仓库里
- 首次部署通过浏览器直接完成 OOBE
- 路由、初始化配置、登录限流、安全模式都存放在 D1
- 如果启用了 `CF_VERSION_METADATA`，每次新部署都会让旧后台会话失效
- 公开反代缓存支持通过环境变量调节

## 快速开始

1. 创建一个 D1 数据库。
2. 在 `wrangler.jsonc` 中把它绑定为 `DB`。
3. 执行初始化 SQL：

```bash
npx wrangler d1 execute DB --file migrations/0001_initial_schema.sql
```

4. 部署 Worker：

```bash
npm run deploy
```

5. 打开 Worker 域名下任意路径。
6. 完成一次 OOBE。

完成后会进入正式运行状态：

- 你设置的后台路径会成为登录入口
- `/_oobe` 会和其他未命中的公开路径一样处理
- `/` 和所有未命中的公开路径都会按 OOBE 中选定的默认入口策略响应

## GitHub + Cloudflare 自动部署

如果你想用 GitHub 提交自动触发 Cloudflare 部署，当前应该用 Cloudflare Workers Builds。

### 一次性接入步骤

1. 先把这个项目推到 GitHub。
2. 确认 Cloudflare 控制台里的 Worker 名称和 `wrangler.jsonc` 里的 `name` 一致。
3. 打开 Cloudflare Dashboard，进入 `Workers & Pages`。
4. 二选一：
   - 新建 Worker：`Create application` -> `Import a repository`
   - 已有 Worker：进入该 Worker -> `Settings` -> `Builds` -> `Connect`
5. 连接你的 GitHub 账号并选择这个仓库。
6. 把项目根目录设为包含 `wrangler.jsonc` 的目录。
7. 部署命令保持默认的 `npx wrangler deploy` 即可；如果你有特殊需要，也可以改成等价命令。
8. 保存并执行首次部署。

### 接入后还要做的事

- 把 D1 数据库绑定到这个 Worker，绑定名必须是 `DB`
- 如果你用了可选环境变量，在 Dashboard 里补上
- 对绑定的 D1 执行 `migrations/0001_initial_schema.sql`
- 打开 Worker 任意地址，完成一次 OOBE

### 分支策略建议

- 把生产分支设置成你真正发布用的分支，比如 `main`
- 如果你想给功能分支生成预览版本，可以开启 non-production branch builds

### 这个仓库的注意点

- 这是 Worker 项目，不是 Pages 项目
- Git 自动部署不会替代 D1 初始化
- Git 自动部署也不会跳过 OOBE，首跑初始化仍然是在浏览器里完成

## OOBE 初始化内容

OOBE 会让你填写三项核心配置：

1. 后台路径
2. 默认入口策略
3. 后台密码

支持的默认入口策略：

- `site`：反代一个默认上游站点，前台 URL 不变
- `login`：直接显示后台登录页
- `text`：返回纯文本
- `status_code`：直接返回指定 HTTP 状态码

如果 D1 中已经存在初始化配置，OOBE 会拒绝覆盖。

## 路由类型

- `proxy`：代理到一个指定上游 URL
- `site`：把一个上游站点挂到某个公开路径下，可选 HTML 重写
- `redirect`：返回 `302` 跳转
- `text`：直接返回纯文本

## 运行要求

### 必需

| 项目 | 值 | 说明 |
| --- | --- | --- |
| D1 绑定 | `DB` | 路由、初始化配置、登录限流、安全模式都依赖它 |

### 可选环境变量

| 环境变量 | 示例 | 用途 |
| --- | --- | --- |
| `DEFAULT_REDIRECT_URL` | `https://example.com` | 仅作为 OOBE 中默认 `site` 策略的预填值 |
| `SESSION_SECRET` | `long-random-string` | 在没有部署版本元数据时，提供稳定的后台会话签名密钥 |
| `PUBLIC_PROXY_CACHE_CONTROL` | `public, max-age=300, s-maxage=300` | 覆盖公开 `proxy/site` 响应的 `Cache-Control` |
| `PUBLIC_PROXY_CACHE_TTL_SECONDS` | `300` | 为公开 `proxy/site` 的 GET/HEAD 请求启用 Cloudflare 边缘缓存，前提是 Cookie 已剥离 |
| `BACKEND_PATH` | `old-admin-path` | 仅用于兼容旧版本迁移 |

补充说明：

- `CONSOLE_PASSWORD` 已不再是必填环境变量。
- 如果既没有 `SESSION_SECRET`，也没有 `CF_VERSION_METADATA`，后台会话会退回运行时内存 secret，在不同 isolate 间可能不够稳定。
- 如果想保留上游原始 `Cache-Control`，可设置 `PUBLIC_PROXY_CACHE_CONTROL=pass-through`。

## 本地开发

推荐：

```bash
cp .env.example .env
npm run dev:local
```

或者使用 Wrangler 原生变量文件：

```bash
cp .dev.vars.example .dev.vars
npm run dev:local
```

这个脚本会：

- 把 Wrangler 状态写到 `local-tmp/wrangler-state`
- 把 Wrangler 配置、日志和本地 registry 写到 `local-tmp/xdg-config`
- 把 npm cache 写到 `local-tmp/npm-cache`
- 自动初始化本地 D1
- 如果存在 `.env`，自动加载；否则回退到 `.dev.vars`

示例 `.env.example` / `.dev.vars.example`：

```dotenv
DEFAULT_REDIRECT_URL=https://example.com
SESSION_SECRET=replace-with-a-long-random-string
PUBLIC_PROXY_CACHE_CONTROL=public, max-age=300, s-maxage=300
PUBLIC_PROXY_CACHE_TTL_SECONDS=300
```

删除 `local-tmp/` 后，本地 D1、Wrangler 状态、日志、registry 和本地 npm cache 基本都会一起重置。

## 数据存储模型

保存在 D1：

- 公开路由定义
- 后台路径
- 默认入口策略及其参数
- 密码哈希、salt、PBKDF2 迭代次数
- 登录失败限流记录
- 安全模式设置
- session revision

不会以长期静态 secret 形式存储：

- 后台会话签名密钥，它优先来自部署版本元数据

## 部署后验证

- 全新实例第一次访问任意路径都会进入 OOBE
- OOBE 提交一次后即永久锁定
- 再访问 `/_oobe` 会和其他未命中的公开路径走同样的处理逻辑
- 你配置的后台路径会显示登录页
- D1 初始化后，路由增删改查可正常使用
- 如果开启了边缘缓存且剥离了 Cookie，公开 GET/HEAD 请求不应持续打满上游

## 安全说明

- 后台登录失败会写入 D1 做限流
- 后台写操作要求同源校验和 CSRF 校验
- 后台 Cookie 使用 `HttpOnly` 和 `SameSite=Strict`
- `proxy/site` 已有私网目标拦截，但 DNS 级 SSRF 边界仍需谨慎
- 后台路径建议足够长且随机
- 后台密码建议使用强密码
