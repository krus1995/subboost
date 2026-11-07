---
name: verify-subboost
description: 验证 SubBoost fork 的 PR、隔离数据库迁移、加密订阅读取或生产上线结果。
---

先读仓库 AGENTS.md 和 docs/fork/FEATURES.md。使用项目固定的 Node 和锁文件。在 Windows PowerShell 使用 `mise exec -- 'C:/Program Files/Git/bin/bash.exe' ops/fork/check.sh`，Linux 上使用 Bash。

1. 按变更先运行相关测试。完整检查运行 `bash ops/fork/check.sh`，可分别运行 source、rules、image 来定位失败。容器检查使用临时数据库与合成订阅数据，检查空库启动和旧库迁移后能否读回原数据。
2. 生产只读探测运行 `bash ops/fork/smoke.sh https://subboost.krus1987.kdns.fr`。需要业务验收时在服务器加 `--business /受限配置文件路径`。检查已授权订阅的配置解密及所有者权限。会话、密码、订阅链接和 API 响应留在受限进程内。
3. 记录测试命令、退出状态、候选 SHA 与实际 Actions run。上线还要检查运行容器的 image ID 和 OCI revision。按实际结果填写 STATE.md，分别记录健康检查、隔离验收和生产业务验收。
