# Wellio Backend

Python 3.12+ / FastAPI / PostgreSQL / Exa。后端仓库：[Wellio-Backend](https://github.com/xinyunfan2-dev/Wellio-Backend)，前端独立仓库：[Wellio](https://github.com/xinyunfan2-dev/Wellio)。本服务不依赖前端仓库、Node 或 SQLite 即可启动。

## 本地启动

安装 Python 3.12+、[uv](https://docs.astral.sh/uv/) 和 PostgreSQL 16+，然后：

```sh
uv sync --frozen
cp .env.example .env
# 修改 .env 中 DATABASE_URL 为你自己的 PostgreSQL 连接
uv run uvicorn wellio.main:application --factory --host 127.0.0.1 --port 8000 --no-proxy-headers --env-file .env
```

已有 PostgreSQL 的队员可以直接复用自己的开发数据库。也可以通过 Docker 创建本项目开发数据库：

```sh
docker compose up -d postgres
# PostgreSQL 就绪后使用上面的 uvicorn 命令
```

完整容器环境：`docker compose up --build`。Compose 的默认密码仅为本地开发示例；真实环境通过私有 `.env` 配置。数据库数据和附件分别保存在持久 volume 中。日常停止用 `docker compose down`，不删除 volume。

服务启动时在 PostgreSQL 事务中检查并应用版本化建表迁移，多进程同时启动有数据库迁移锁。`DATABASE_URL` 必填，不会回退 SQLite。业务快照 `schemaVersion=4` 与数据库结构迁移版本分别管理。

验证服务：

```sh
curl http://127.0.0.1:8000/healthz
curl -c /tmp/wellio-cookie.txt http://127.0.0.1:8000/api/state
```

Swagger 文档：`http://127.0.0.1:8000/docs`，OpenAPI：`/openapi.json`。`/api/actions` 展示按 `kind` 区分的请求类型。

## 与前端连接

前端 `WELLIO_API_BASE_URL=http://127.0.0.1:8000`，浏览器仍请求前端同源 `/api/*`。后端 `WELLIO_PUBLIC_ORIGIN` 填实际前端来源，多个来源用逗号分隔。Cookie、Origin/Referer 与响应状态经前端代理保留。

| 接口 | 用途 |
| --- | --- |
| `GET /api/state` | 创建或恢复签名会话，返回已保存快照 |
| `POST /api/actions` | 语言、Reset、训练生命周期、Apply/Start、撤销等严格动作 |
| `POST /api/attachments` | multipart `file` + `purpose=food/menu`，私有图片上传 |
| `GET /api/attachments/{id}` | 读取当前会话和 epoch 的原始图片 |
| `POST /api/chat` | 保留前端契约；CopilotKit 接入前明确返回 503 |

所有业务写入沿用 camelCase、版本冲突、请求去重和回执格式。数据库事务把快照、回执、授权消费、餐食操作链同时提交；跨进程请求在同一会话上顺序执行。失败不会留下部分餐食变更。Reset 只影响当前会话，旧 epoch 请求不能写回。

## Exa 搜索

设置后端 `EXA_API_KEY`，依赖锁定 `exa-py==2.14.0`。默认 `type="auto"`、`contents={"highlights": True}`。返回实际标题、URL、摘录与读取时间，菜单保留 `priceStatus="unknown"`，不从缺失证据编造价格或营养。未配置密钥时显式返回 `SEARCH_NOT_CONFIGURED`。SDK 服务可直接作为后续 Agent 工具调用。

搜索是后端工具服务，本阶段不新增公开付费搜索 HTTP 接口。后续 Agent 可直接调用：

```python
from wellio.search import ExaSearchService

search = ExaSearchService()  # 从 EXA_API_KEY 读取
try:
    result = await search.search({"query": "Hong Kong restaurant menu", "numResults": 10})
    menu = await search.search_restaurant_menu({"restaurant": "餐厅名", "city": "Hong Kong"})
finally:
    await search.close()
```

规范：[Exa coding-agent search API guide](https://docs.exa.ai/reference/search-api-guide-for-coding-agents)。测试使用受控 SDK 传输，不消耗真实搜索配额；真实 Exa 调用需要部署环境的密钥。

## 代码与职责

- `wellio/app.py`：FastAPI HTTP、会话和同源校验。
- `wellio/database.py`、`migrate.py`、`data/001_initial.sql`：PostgreSQL、事务和版本化迁移。
- `workouts.py`、`read_services.py`：训练、提案、排期和营养汇总。
- `meals.py`、`authorization.py`、`conditions.py`：明确用户来源授权、餐食操作与单调版本撤销。
- `runtime.py`：持久化检查账本和过期运行恢复，不执行模型。
- `attachments.py`：图片完整解码、会话/epoch 隔离与私有权限。
- `search.py`：Exa 检索服务。

图片支持 JPEG、PNG、WebP，最多 10 MiB、4000 万解码像素。保存原始字节与校验和；附件根目录需要跨重启持久化。部署多个 API 实例时应挂载同一个受控附件卷或另外接对象存储。

演示数据明确标记 `demo_fixture_v1`，不是用户设备采集数据。PostgreSQL 从新数据库开始；原工作区旧 SQLite 文件不被本服务读取或改写，旧数据导入不是隐式启动操作。

## 验证结果（2026-09-12）

后端全量 **222/222** 通过，数据库实测 PostgreSQL 18.6。包含原生 HTTP、事务/并发/回执、授权/撤销、图片隔离和 Exa 35 项受控 SDK 测试。前端 34 项浏览器测试与完整服务重启两次后的持久化烟测通过。Python wheel 构建及 Compose 语法检查通过；未运行 Docker 容器或真实付费搜索。

## 测试

```sh
uv run pytest -q
```

测试默认寻找本机 PostgreSQL `initdb` / `pg_ctl` / `postgres`，创建独立临时实例与独立测试 schema，结束后清理。可通过 `WELLIO_PG_BIN` 指定二进制目录。测试不会使用开发 `.env` 的数据库或真实 Exa 密钥。也可显式提供 `WELLIO_TEST_DATABASE_URL` 指向专用测试数据库，测试仅创建并清理自己的临时 schema。

需要前端构建产物的完整生产重启验证：

```sh
# 在前端先运行 npm run build，然后从本仓库运行
uv run python tests/production_smoke.py /absolute/path/to/Wellio
```

本阶段完成业务服务迁移，**CopilotKit 和 Python Agent 执行仍属于下一阶段**。当前 `capabilities.agent=false`，不会用固定文案代替模型回复。后续 Agent 应调用这里的领域服务及 Exa 工具，并继续保留版本、授权、显式 Apply 与撤销语义。
