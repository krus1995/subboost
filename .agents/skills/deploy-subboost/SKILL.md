---
name: deploy-subboost
description: 跟进 SubBoost fork 的 main 发布、重试既有制品、核对生产身份或处理发布中断和恢复。
---

先读 docs/fork/STATE.md 与执行手册第 9 至 12 节。核对首次隔离恢复演练和服务器配置。收到部署指令后用 `gh workflow run fork-build-deploy.yml --ref main` 启动构建和部署。用 `gh run list --workflow fork-build-deploy.yml --branch main` 找到对应 SHA，用 `gh run watch <run-id> --exit-status` 跟进。发布重试使用 `gh workflow run fork-build-deploy.yml --ref main -f build_run_id=<原构建运行编号>`。

首次接管时，main 可以先生成已验证制品。服务器预检、加密备份恢复演练及 production 凭据核验完成后运行 `gh variable set FORK_DEPLOY_ENABLED --repo krus1995/subboost --body true`，再用原构建运行编号发布当前 main。只构建制品的运行记录不能证明生产上线。

在已核验的服务器查询 `/usr/local/sbin/subboost-fork-deploy status <完整SHA>`。断线后查同一 SHA 的回执。核对本机和生产域名的 live、ready、加密订阅读取、cron 以及实际容器的 image ID、OCI revision。只记录脱敏结果。

激活前失败使用本次停写后的已验备份和保留的旧配置、镜像。到达 ACTIVATING 后，若缺少绑定这对镜像和迁移摘要的兼容性证据，保留现库并向前修复。需要恢复旧时间点时记录恢复点、当前备份和可能丢失的写入，取得对应授权。完整命令和目标身份以本次服务器记录为准。
