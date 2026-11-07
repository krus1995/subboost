# Fork 接管记录

```yaml
phase: bootstrap
status: in_progress
fork_head_sha: 401534742802e2b1542783197ce66451bad82739
upstream_release: v2.11.0
upstream_commit_sha: 401534742802e2b1542783197ce66451bad82739
production_source_sha: null
production_image_id: null
production_url: https://subboost.krus1987.kdns.fr/
last_verified_run_url: null
last_backup_receipt: null
blocking_items:
  - 远端 PR 和必需检查尚待验证
  - 生产主机身份、部署凭据与隔离恢复演练尚待验证
next_action: verify_host_and_prepare_restore_drill
```

2026-11-08 首次接管，从 `origin/main` 创建 `codex/fork-delivery`。原工作区仅有用户提供的未跟踪手册，保留原件。实测首页、登录页 HTTP 200，公开 live 返回 ok，ready 返回 database ready。镜像、数据库卷、密钥配对及真实订阅的读取结果仍需在生产主机核对。

## 上游合并

GitHub CLI 以仓库管理员 krus1995 登录。production environment 只允许 main 分支，已读取策略并核对。DEPLOY_USER、PRODUCTION_URL 已设置。其他部署参数等现场核对后填入。

固定版本 Pstack、Bun 与 GitHub CLI 见 `ops/fork/toolchain.lock.json`。Codex CLI 新会话与真实子代理 `/root/verify_skill_discovery` 各自读取 Pstack 的两个技能、三个项目技能及项目 AGENTS.md。技能发现与显式调用已验证。自动 SessionStart hook 由本机用户在 `/hooks` 管理。

`bash ops/fork/sync-upstream.sh v2.11.0` 返回 no-op，B 和 U 相同。上游 annotated tag 的对象为 `3d339f4214dea30b168202343d3168e539d5b9cc`。隔离测试 `bash ops/fork/test-upstream.sh` 已验证重复执行、接续远端任务分支、干净合并、冲突解决、B/U 祖先关系和拒绝移动过的 tag。

## 首次维护窗口

先核对 Compose 标签、全部配置文件、数据库卷、既有加密配置和 Tunnel 实际 origin，运行只读业务基线。固定当前官方镜像和配置。通过专用恢复演练将备份还原到新建的隔离库，记录摘要、对象身份和实际订阅读取。验证后才能停写、重新备份和切换。发生故障时按已持久化的激活阶段处理，详见 [执行手册第 11 节](AGENT_RUNBOOK.md)。

部署后的证据记在 Actions summary 和服务器按 SHA 保存的回执中。每次生产上线不单独提交状态更新。
