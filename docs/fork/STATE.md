# Fork 接管记录

```yaml
phase: awaiting_first_production_receipt
status: in_progress
fork_head_sha: 401534742802e2b1542783197ce66451bad82739
upstream_release: v2.11.0
upstream_commit_sha: 401534742802e2b1542783197ce66451bad82739
production_source_sha: null
production_image_id: null
production_url: https://subboost.krus1987.kdns.fr/
last_verified_run_url: https://github.com/krus1995/subboost/actions/runs/42399628853
last_backup_receipt: /var/lib/subboost-fork/rehearsal.json
auto_deploy: enabled_after_rehearsal
blocking_items: []
next_action: deploy_current_main_and_verify_active_receipt
```

2026-11-08 首次接管，从 `origin/main` 创建 `codex/fork-delivery`。原工作区仅有用户提供的未跟踪手册，保留原件。首次公网检查中，首页、登录页返回 HTTP 200，live 返回 ok，ready 返回 database ready。随后在生产主机完成的验证见下方维护窗口记录。

## 开发与发布环境

GitHub CLI 以仓库管理员 krus1995 登录。production environment 只允许 main 分支，DEPLOY_USER、PRODUCTION_URL 已设置。仓库变量 FORK_DEPLOY_ENABLED 初始为 false。main 的镜像构建与留存可先运行；核对主机、凭据和恢复演练后再开启生产部署。

固定版本 Pstack、Bun 与 GitHub CLI 见 `ops/fork/toolchain.lock.json`。新会话与子代理各自从技能目录发现 Pstack 的两个技能、三个项目技能，读到了同一份 AGENTS.md。本机针对此项目运行 `hooks/list`，Pstack SessionStart 返回 `enabled=true`、`trustStatus=trusted`、`errors=0`。

已回读 main 分支保护。合并需要 PR 达到最新 base，并通过 GitHub Actions 提供的 `fork-required`，管理员也受约束。首轮测试入口缺少 test-host.py，required job 返回失败。补交脚本后 source、image 与汇总检查通过。[失败记录](https://github.com/krus1995/subboost/actions/runs/42396677192) · [修复后通过](https://github.com/krus1995/subboost/actions/runs/42397014996)

## 上游合并

`bash ops/fork/sync-upstream.sh v2.11.0` 返回 no-op，B 和 U 相同。上游 annotated tag 的对象为 `3d339f4214dea30b168202343d3168e539d5b9cc`。隔离测试 `bash ops/fork/test-upstream.sh` 已验证重复执行、接续远端任务分支、干净合并、冲突解决、B/U 祖先关系和拒绝移动过的 tag。

## 首次维护窗口

已按控制台指纹核对 SSH 主机并登录。现场 app 的 Compose 标签指向正式文件，db 和 cron 的标签仍指向上游安装器启动容器时使用的临时文件。两项服务的配置哈希、镜像 ID 和网络均与正式 Compose 配置匹配。

容器身份回归已通过 `bash ops/fork/check.sh host`。在隔离的 Docker 29.9.3 和 Compose 5.7.0 中，预检识别了安装器创建的 db 和 cron。用登记的 override 重建 app 后，三个服务的身份检查仍通过。随后修改 Compose 中的 db 环境变量，检查拒绝接管，三个容器仍在运行。

第一次 main 构建在 `99c9ec5e4371c2132cf47d759501970c11dd5b68` 完成，生产开关关闭。下载其制品并核对压缩包摘要后，在隔离 Docker 29 导入时发现，构建端用配置摘要表示镜像 ID，目标端用 OCI 镜像清单摘要表示同一镜像。后续清单分别记录这两项，服务端同时核对它们的引用关系、容器镜像标签和实际运行 ID。首发使用修复后当前 main 的制品。[初次构建](https://github.com/krus1995/subboost/actions/runs/42398090368)

公网版本接口在切换前返回 2.11.0。修复制品校验后，main 完成构建与制品验证。[构建记录](https://github.com/krus1995/subboost/actions/runs/42399628853)

生产预检和恢复演练均已通过。演练将停写后的生产备份恢复到隔离库，旧镜像成功解密已有订阅。原 app 和 cron 恢复运行后，本机和公网均能读回订阅，原数据库卷和原库 OID 保持一致。复查覆盖另外 2 个健康入口和 4 个运行中的容器。systemd 任务退出码为 0，主机回执 `/var/lib/subboost-fork/rehearsal.json` 记录 `smokePassed=true`。

演练通过后已启用 `FORK_DEPLOY_ENABLED` 并回读确认。首次部署仍需核对生产容器的镜像 ID 和 OCI revision，并验收订阅读取、cron 和 Tunnel 入口。后续运行以 Actions summary、主机 `/var/lib/subboost-fork/current.json` 和对应 SHA 的部署回执为准。查询与故障恢复命令见[主机接管说明](SERVER.md)。

合并提交 `84c45a9` 触发首次发布。两台 GitHub runner 均已通过固定主机公钥的 SSH 登录，但 SCP 上传缓慢，其中一次在 155 秒内传了约 3.1 MB，全包约 319 MB。观察期间尚未提交制品，原站继续运行。[首次发布尝试](https://github.com/krus1995/subboost/actions/runs/42447035721)

部署作业的总时限现为 360 分钟。上传前，临时 runner 尝试启用 TCP BBR 拥塞控制并输出实际算法。上传完成后才开始计算提交和等待回执的 90 分钟，整项作业仍受总时限约束。BBR 对这条公网线路的实际传输速度有待后续发布验证。

## 验收记录

记录中的 fork_head_sha 是接管开始时的 main。用 `git ls-remote origin refs/heads/main` 读取最新 main，通过 PR 的独立审查记录核对最终候选和合并结果。[实施 PR](https://github.com/krus1995/subboost/pull/1)

| 阶段 | 已验证 | 剩余现场验收 |
| --- | --- | --- |
| P0 | GitHub 管理权限、上游版本、SSH 主机与数据库卷身份、订阅解密、Tunnel origin 及其他服务基线 | 已完成 |
| P1 | 固定插件版本、19 项角色设置、项目规则及 3 个技能通过加载验证，项目的 SessionStart 已启用并受信任 | 已完成 |
| P2 | 2,657 个单测通过，分支覆盖率 97.05%。空库与旧库六个迁移通过，破坏密文能使回归失败 | 新候选的审查和检查随 PR 更新 |
| P3 | 真实 v2.11.0 返回 no-op；隔离分支的冲突与接续演练通过 | 日常在用户发起同步时运行 |
| P4 | production 环境只允许 main，部署凭据已配置，本机与首发 runner 均用固定主机公钥登录成功 | 已完成 |
| P5 | 制品、摘要、重复请求、乱序 SHA、SSH 中断后查询都已在隔离环境检查 | main 的构建记录见 Actions；首次真实传输后核对容器 image ID |
| P6 | 生产备份已在隔离库恢复，旧镜像成功解密原订阅，演练回执已保存。隔离测试另覆盖失败迁移和损坏密文 | 首发停写后重新备份并核对本次部署回执 |
| P7 | 生产预检通过，演练后原 app、cron 和 Tunnel 入口正常 | fork 接流量后复查订阅、cron、网络与其他入口 |
| P8 | PR 检查和 main 制品构建已运行，主机恢复演练通过 | 真实 runner 首发、同一制品的重试及断线后回执 |
| P9 | 主机已有演练回执，查询和续接命令已记录 | 首发后对照 Actions 和主机回执核对生产 SHA、镜像 ID 与发布备份位置 |
