# Wellio Backend

本仓库负责 FastAPI 业务服务与 CopilotKit Node Runtime。前端独立仓库为 xinyunfan2-dev/Wellio-Frontend，不能混入 React 页面或素材。

- 当前架构：CopilotKit BuiltInAgent factory（agent-runtime/）+ FastAPI + PostgreSQL(psycopg 3) + Exa Python SDK。禁止 SQLite fallback 或第二个 Python 模型执行器。
- 模型通过 OpenRouter，默认 deepseek/deepseek-v4.1-flash；OPENROUTER_API_KEY 仅服务端配置。Exa 默认 auto + highlights。缺少密钥或真实结果时明确不可用。
- Node 通过固定内部 RPC 调用业务；FastAPI 验证服务令牌、签名会话、原文授权、版本、运行租约和事务。PostgreSQL 是唯一持久业务状态及消息源。
- 保留 session/resetEpoch/requestId、原始来源授权、事务、显式 Apply 和 Undo 语义。
- 提交前运行 uv run --frozen pytest -q；Node 改动运行 npm --prefix agent-runtime test 与 npm --prefix agent-runtime run build。测试使用隔离 PostgreSQL 和官方 SDK 测试模型，不能读取开发 .env 的数据库或调用付费服务。
- 完整栈通过 tests/copilot_smoke.py 验证；受控模型结果不等于真实 OpenRouter 或 Exa 验收。演示目标 macOS Apple Silicon，本地部署且代码先于打包。
- 先检查远端队友修改，使用独立分支和 PR；不提交真实凭据、运行数据库、附件、.venv、node_modules 或构建产物。
