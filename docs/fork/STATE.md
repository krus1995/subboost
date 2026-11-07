# Fork 接管记录

```yaml
phase: production_preflight
status: blocked
fork_head_sha: 401534742802e2b1542783197ce66451bad82739
upstream_release: v2.11.0
upstream_commit_sha: 401534742802e2b1542783197ce66451bad82739
production_source_sha: null
production_image_id: null
production_url: https://subboost.krus1987.kdns.fr/
last_verified_run_url: https://github.com/krus1995/subboost/actions/runs/42397014996
last_backup_receipt: null
auto_deploy: disabled_until_host_rehearsal
blocking_items:
  - 待核对公网 SSH 地址、端口、主机公钥及 root 登录
  - 待核对生产资源、已有订阅的解密及真实备份恢复
next_action: verify_host_and_prepare_restore_drill
```

2026-11-08 首次接管，从 `origin/main` 创建 `codex/fork-delivery`。原工作区仅有用户提供的未跟踪手册，保留原件。实测首页、登录页 HTTP 200，公开 live 返回 ok，ready 返回 database ready。镜像、数据库卷、密钥配对及真实订阅的读取结果仍需在生产主机核对。

## 开发与发布环境

GitHub CLI 以仓库管理员 krus1995 登录。production environment 只允许 main 分支，DEPLOY_USER、PRODUCTION_URL 已设置。仓库变量 FORK_DEPLOY_ENABLED 初始为 false。main 的镜像构建与留存可先运行；核对主机、凭据和恢复演练后再开启生产部署。

固定版本 Pstack、Bun 与 GitHub CLI 见 `ops/fork/toolchain.lock.json`。新会话与子代理各自从技能目录发现 Pstack 的两个技能、三个项目技能，读到了同一份 AGENTS.md。Codex 的 hooks/list 返回 Pstack SessionStart 的信任状态为 untrusted。显式调用技能可用；如需自动加载，用户在 `/hooks` 核对并信任这一项。

已回读 main 分支保护。合并需要 PR 达到最新 base，并通过 GitHub Actions 提供的 `fork-required`，管理员也受约束。首轮测试入口缺少 test-host.py，required job 返回失败。补交脚本后 source、image 与汇总检查通过。[失败记录](https://github.com/krus1995/subboost/actions/runs/42396677192) · [修复后通过](https://github.com/krus1995/subboost/actions/runs/42397014996)

## 上游合并

`bash ops/fork/sync-upstream.sh v2.11.0` 返回 no-op，B 和 U 相同。上游 annotated tag 的对象为 `3d339f4214dea30b168202343d3168e539d5b9cc`。隔离测试 `bash ops/fork/test-upstream.sh` 已验证重复执行、接续远端任务分支、干净合并、冲突解决、B/U 祖先关系和拒绝移动过的 tag。

## 首次维护窗口

公网版本接口返回 2.11.0。当前未取得生产容器 image ID 或 OCI revision。仓库能构建 fork 镜像，生产是否已切换以服务器回执和生产业务验收为准。管理员的安装、演练、恢复和查询命令见 [主机接管说明](SERVER.md)。

先核对 Compose 标签、全部配置文件、数据库卷、既有加密配置和 Tunnel 实际 origin，运行只读业务基线。固定当前官方镜像和配置。通过专用恢复演练将备份还原到新建的隔离库，记录摘要、对象身份和实际订阅读取。验证后才能停写、重新备份和切换。发生故障时按已持久化的激活阶段处理，详见 [执行手册第 11 节](AGENT_RUNBOOK.md)。

部署后的证据记在 Actions summary 和服务器按 SHA 保存的回执中。每次生产上线不单独提交状态更新。

## 验收记录

记录中的 fork_head_sha 是接管开始时的 main。用 `git ls-remote origin refs/heads/main` 读取最新 main，通过 PR 的独立审查记录核对最终候选和合并结果。[实施 PR](https://github.com/krus1995/subboost/pull/1)

| 阶段 | 已验证 | 剩余现场验收 |
| --- | --- | --- |
| P0 | GitHub 管理权限、上游版本、公开页面与健康响应 | 主机与卷身份、密钥配对、Tunnel 实际路由及其他服务基线 |
| P1 | 固定插件版本、19 项角色设置、项目规则及 3 个技能通过格式与加载探针 | 自动 SessionStart 仍待用户信任 |
| P2 | 2,657 个单测通过，分支覆盖率 97.05%。空库与旧库六个迁移通过，破坏密文能使回归失败 | 新候选的审查和检查随 PR 更新 |
| P3 | 真实 v2.11.0 返回 no-op；隔离分支的冲突与接续演练通过 | 日常在用户发起同步时运行 |
| P4 | production environment 及 main 部署策略已回读 | 本机与实际 runner 的 SSH 登录、固定主机密钥验证 |
| P5 | 制品、摘要、重复请求、乱序 SHA、SSH 中断后查询都已在隔离环境检查 | main 的构建记录见 Actions；首次真实传输后核对容器 image ID |
| P6 | 隔离 PG16 的加密备份实还原，新表和损坏密文的失败路径有演练 | 现有生产数据库的备份、恢复与解密回执 |
| P7 | 服务器包装器已实现候选隔离、停写边界与激活前恢复 | 生产切换、订阅、cron、网络与其他入口 |
| P8 | PR 检查实际运行；main 的制品构建与生产部署有独立状态 | 真实部署、同一制品的重试及断线后回执 |
| P9 | 命令及续接条件已记录 | 上线后在 Actions 和服务器回执填写生产 SHA、image ID、备份位置 |
