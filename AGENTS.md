# SubBoost fork 开发与发布

开始任务先读 `docs/fork/STATE.md`、`docs/fork/FEATURES.md` 和相关源码。接管、发布故障或更改流程时查 `docs/fork/AGENT_RUNBOOK.md` 对应章节。

- 在任务分支写下可检验的验收条件，再修改相关模块。已有未提交工作时使用独立 worktree。新功能优先复用已有扩展点。
- Windows 上按用户的开发环境手册用 mise 激活项目 Node，通过 Git Bash 执行 Bash 脚本。依赖按现有 npm 锁文件恢复。
- 使用 Pstack 的 poteto-mode 安排验证和独立审查。审查记录注明 base、候选完整 SHA、审查者、发现及处理结果。base 或候选变化后复核受影响的改动。
- 统一检查入口为 `bash ops/fork/check.sh`。CI、规则、业务断言、覆盖率或依赖有改动时说明理由，依赖变更同时提交锁文件。保留现有迁移文件，schema 变更以新迁移提交。
- 每项定制登记在 FEATURES.md，注明业务入口、数据、上游交叉区域和回归命令。流程和工具的修改只登记在 STATE.md。
- 上游合并由用户发起。核对 PR 的 base、head 与 `fork-required` 后以 merge commit 合并。main 上的自动部署使用完整 SHA，记录镜像、前一版本、已验备份及实际结果。
- 切换到 fork 的前提是现有服务器身份、资源及隔离恢复演练通过。正式 app 可接流量前持久记录 ACTIVATING，此后旧库恢复需要用户确认可能丢失的写入。运维入口和原始授权范围见执行手册第 9 至 12 节。
- 每阶段将结果、命令或链接、下一步记入 STATE.md；生产运行记录留在 Actions 和服务器回执中。缺凭据或检查失败时保留现场，写明未验项。

| 规则 | 适用范围 | 执行检查 | 失败证据 |
| --- | --- | --- | --- |
| UP-01 | 上游合并 | `test-upstream.sh` 及 `git merge-base --is-ancestor` 检查 B、U | 非零退出，或 tag 身份变化 |
| REG-01 | 应用与数据 | `check.sh source`、`check.sh image` 及 FEATURES.md 对应的行为断言 | 断言、覆盖率或旧库升级失败 |
| ART-01 | 发布制品 | 比对清单摘要、镜像 ID、OCI revision 和目标 SHA | 在停止 app 前拒绝不一致的制品 |
| CFG-01 | 工作流和部署配置 | `check.sh rules` 及服务器预检 | 仓库、分支、架构、域名或生产资源身份不一致 |
