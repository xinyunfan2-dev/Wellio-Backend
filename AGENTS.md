# Wellio Backend

本仓库仅包含后端。前端仓库为 xinyunfan2-dev/Wellio，不能混入 React 页面或素材。

- 当前架构：FastAPI + PostgreSQL(psycopg 3) + Exa Python SDK。禁止 SQLite fallback。
- EXA_API_KEY 仅后端使用，搜索默认 auto + highlights。没有凭据或真实结果时明确不可用。
- CopilotKit 在后续分支接入，不能把历史 TypeScript SDK 测试算作 Python Agent 验证。
- 保留 session/resetEpoch/requestId、版本校验、原始来源授权、事务、显式 Apply 和 Undo 语义。
- 提交前运行 uv run --frozen pytest -q；测试使用临时 PostgreSQL，不能读取开发 .env 的数据库。
- 先检查远端队友修改，使用独立分支和 PR；不提交真实凭据、运行数据库、附件、.venv 或缓存。
