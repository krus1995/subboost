# Fork 接管记录

```yaml
phase: production_active
status: completed
fork_head_sha: 401534742802e2b1542783197ce66451bad82739
upstream_release: v2.11.0
upstream_commit_sha: 401534742802e2b1542783197ce66451bad82739
production_source_sha: 9954b1790fdff83db8224abf6b67f7578605b74c
production_image_id: sha256:119137a1f337867f63c31bc1817b4aedaf449b259fbd0e3ba03c2db3499a0d61
production_url: https://subboost.krus1987.kdns.fr/
last_verified_run_url: https://github.com/krus1995/subboost/actions/runs/42448393728/attempts/2
last_backup_receipt: /var/lib/subboost-fork/backups/9954b1790fdff83db8224abf6b67f7578605b74c-6565ae1a50/backup.json
deployment_trigger: workflow_dispatch
blocking_items: []
next_action: verify_next_main_release
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

演练通过后已启用 `FORK_DEPLOY_ENABLED` 并回读确认。此页保存首发快照。后续运行以 Actions summary、主机 `/var/lib/subboost-fork/current.json` 和对应 SHA 的部署回执为准。查询与故障恢复命令见[主机接管说明](SERVER.md)。

合并提交 `84c45a9` 触发首次发布。两台 GitHub runner 均已通过固定主机公钥的 SSH 登录，但 SCP 上传缓慢，其中一次在 155 秒内传了约 3.1 MB，全包约 319 MB。观察期间尚未提交制品，原站继续运行。[首次发布尝试](https://github.com/krus1995/subboost/actions/runs/42447035721)

部署作业的总时限现为 360 分钟。上传完成后才开始计算提交和等待回执的 90 分钟。发布 `9954b17` 时，runner 记录的 TCP 拥塞控制算法为 `bbr`，全包经 SCP 约 4 分钟传完。

第一次发布尝试到达 `ACTIVATING` 后，正式 Compose 仍从上游的 `SUBBOOST_CANDIDATE_IMAGE` 选择旧镜像。主机已将 app 镜像选择改为正式 `SUBBOOST_IMAGE`，核对渲染模型只有 app 的镜像改变后启动目标镜像。原库 OID 保持一致，公网解密订阅读取、cron 和另外两个入口均通过。观察者断开 SSH 并重新连接后，能查回同一发布任务。主机重新核验后写入 `ACTIVE` 回执，并标记 `reconciled`。第二次尝试用相同制品复核成功，systemd 中仍是第一次提交的任务。[首次尝试](https://github.com/krus1995/subboost/actions/runs/42448393728/attempts/1) · [同一制品复核](https://github.com/krus1995/subboost/actions/runs/42448393728/attempts/2)

针对这次故障，包装器在预检、首次演练和发布停写前预演镜像选择。真实 Compose 渲染回归已覆盖上游候选变量、进程环境覆盖、缺失或重复赋值，以及镜像变量同时改变其他服务的情况。

## 验收记录

记录中的 fork_head_sha 是接管开始时的 main。用 `git ls-remote origin refs/heads/main` 读取最新 main，通过 PR 的独立审查记录核对最终候选和合并结果。[实施 PR](https://github.com/krus1995/subboost/pull/1)

| 阶段 | 已验证 | 剩余现场验收 |
| --- | --- | --- |
| P0 | GitHub 管理权限、上游版本、SSH 主机与数据库卷身份、订阅解密、Tunnel origin 及其他服务基线 | 已完成 |
| P1 | 固定插件版本、19 项角色设置、项目规则及 3 个技能通过加载验证，项目的 SessionStart 已启用并受信任 | 已完成 |
| P2 | 2,657 个单测通过，分支覆盖率 97.05%。空库与旧库六个迁移通过，破坏密文能使回归失败 | 新候选的审查和检查随 PR 更新 |
| P3 | 真实 v2.11.0 返回 no-op；隔离分支的冲突与接续演练通过 | 日常在用户发起同步时运行 |
| P4 | production 环境只允许 main，部署凭据已配置，本机与首发 runner 均用固定主机公钥登录成功 | 已完成 |
| P5 | 首发制品经 SCP 送达，实际镜像 ID 与回执吻合。重复请求及乱序 SHA 在隔离环境验证 | 已完成 |
| P6 | 首发停写后重新备份并记录回执。生产恢复演练通过解密检查，隔离测试覆盖失败迁移和损坏密文 | 已完成 |
| P7 | 向前修复后目标镜像运行，生产订阅、cron 和其他入口通过 | 下一次 main 发布核对新增的停写前镜像选择检查 |
| P8 | 实际 runner 交付、观察者断线重连及同一制品重试均已验证 | 已完成 |
| P9 | Actions 和主机回执已核对，首发 SHA、镜像 ID 与备份回执位置见上方快照 | 已完成 |

发布流程验收：所有 PR 继续运行 `fork-required`。合并到 main 后不构建镜像、不部署。手动启动 `Fork build and deploy` 时，为当前 main 构建镜像或复用同一提交的已验证制品，再部署到生产。回归入口为 `bash ops/fork/check.sh rules`。

本机开发约定集中在项目 AGENTS.md，涵盖工作树目录和清理时机、技能范围及 Pstack 的 19 行角色映射和默认推理强度。

## Loon 完整配置

验收条件：用同一份已保存的节点、组与规则生成 Clash 和 Loon 两种输出，首页能下载，管理页能复制订阅地址并导入 Loon。Loon 配置保留节点顺序、组成员和规则目标，区分精确域名与域名后缀，保留 IPv4、IPv6 与 FINAL。遇到无法保留的设置，提示具体项目。公开读取使用已保存的节点快照，重置 token 后两种旧地址均失效。用自动化测试核对转换及接口；iPhone 上的实际导入、规则命中与远程配置刷新另行记录。

标准模板用 22 份真实上游规则生成 166,335 行配置，约 7.6 MB。检查覆盖 GitHub 精确域名、后缀和 Telegram IPv6 网段。首页仅显示前 200 行，下载保留全文。本地 HTTP 检查读到了首页入口和 GitHub 规则文件。桌面浏览器插件缺少网络策略，按钮点击未在浏览器验收。iPhone 待验证导入、广告与 GitHub 的实际分流，以及同一地址更新后的刷新结果。

独立审查基线为 `8181cec4fb444bfe8ac99d75183f24c4b638e811`，审查者为 Pstack 独立审查代理 final_review。候选 `4dc01c779f06d3e7438ef64a2717fd7719e36878` 中，名为 `module:select` 的节点作为规则目标时可能被解释成策略组。修复后预检和规则输出共用目标名称，已添加内置组开关和禁用自定义组的回归。管理页还修复了下载回调提前返回的问题。审查者复核代码候选 `e8f27b4ed60e331178245a252093f06c5eefbd4e` 后关闭该问题。

仓库规则检查已通过。源码、容器及隔离旧库的完整检查由功能 PR 的 Fork CI 记录。合并后待收到部署指令再发布。

### Clash 与 Loon 输出对照

复测验收条件：同一份已保存配置分别从两个公开订阅地址读取，比较节点、组成员的顺序、规则目标和兜底策略；覆盖显式关闭全部组、字面节点名与组引用重名、真实规则的精确域名与后缀，以及 IPv4/IPv6。分别记录文件输出、客户端规则优先级差异和真机未验项。

使用 8 个合成节点（Shadowsocks、VMess、VLESS、Trojan、Hysteria2、HTTP、HTTPS 和 SOCKS5）导出同一份标准配置，逐项核对 14 个策略组的名称、顺序与成员。按 Clash 文件引用的规则集展开后，共 166,308 行规则，包括兜底，逐行匹配 Loon 输出。规则数据固定在 [MetaCubeX 提交 26cf4440](https://github.com/MetaCubeX/meta-rules-dat/tree/26cf4440307754d2c2f65cf2f0457c0ae814900f/geo)。[Mihomo v1.19.33](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33) 将 22 份原始文本和对应 MRS 文件分别转换为内核识别的规则后，两边内容逐项相同。标准和空组两份 Clash 导出均通过该内核的 `-t` 检查。

对照复现并修复了已保存订阅关闭全部组后 Clash 恢复默认组、字面节点名与策略组引用冲突、缺省 VMess alterId 导致 Mihomo 拒收配置的问题。Loon 导出也会写明支持协议的 UDP 默认值，遇到直接指向订阅信息节点的规则会提示调整。升级库的 HTTP 验收会读取两条真实订阅地址，核对节点及策略、组改名、空组兜底和 token 撤销。独立审查者 parity_review 从 `f350ffe32a964a68ae73cc4b459af7aaa890e91e` 复核代码候选 `f4998f3f1ae7a4b3201675821b5def2aaedb9c81` 和 HTTP 验收增量 `01d26d663269532b4902f181ad17aa6e79982513`，无阻断发现。完整检查归档于 [PR #8](https://github.com/krus1995/subboost/pull/8)。

### Loon 节点名称兼容性

验收条件：带方括号、逗号等标点的 VLESS 节点从已保存订阅的 Loon 地址可读取；节点声明、组成员、规则和兜底引用同一名称。导出后的名称不会与其他节点或组混淆。原订阅和 Clash 导出的节点名称保留原样。

旧版运行 `npm run test:unit -- loon-names.test.ts` 时，8 项中有 4 项失败，复现了首个 VLESS 节点的名称报错。修复后 5 个相关测试文件共 170 项通过，两处改动的 TypeScript 文件通过 ESLint，`bash ops/fork/check.sh rules` 通过。独立审查者 name_review_plan 核对基线 `96ec3f4c0fe90dca0dc380d8e700bb2add1bc29a` 与代码候选 `2139371308ac3a3c70a66073f02bf53bad4b1635`，未发现阻断问题。PR 的镜像检查会保存含标点的 VLESS 测试订阅，读取与「检查 Loon 配置」相同的地址，核对状态码、兜底规则及 Clash 原名。Loon 真机导入待验。

### Loon 节点协议与混合订阅

补充验收条件：混合订阅中的通用 Safari 指纹按 Loon 支持的配置输出，记录使用的版本，实际订阅读取时保留其分流引用。未列入官方清单的传输继续逐项提示；SSR 的协议、混淆和加密按官方清单验证。

验收条件：依照 Loon 官方节点文档转换可表达的节点和参数，覆盖真实混合订阅中出现的协议。导出中列出无法保留的节点及原因，策略组和规则的引用必须有效。仅在配置确实含可用代理节点时发布部分结果；所有节点都不兼容或规则直接指向不可用节点时说明具体阻碍。保留保存的订阅与 Clash 输出。用实际生产链接核对现状与发布后的结果，只记录状态码和汇总。

生产链接复现 HTTP 422。首次对同一订阅的 Clash 输出做了脱敏回放，首项传输是 XHTTP。候选可以序列化 77 个节点中的 34 个，跳过 43 个；用对应的 93 份公开规则展开后，回放得到 40 个策略组和 171,144 条规则，所有目标都有声明。回放还原了原订阅的全部 94 条入口规则。部分组成员从公开输出推导，生产结果以发布后对原链接的 HTTP 检查为准。补上 Safari 系列指纹映射后重跑，77 个节点中导出 44 个，其中 10 个使用 `safari-ios18`。跳过的 33 个为 XHTTP 10 个、HTTPUpgrade 3 个、gRPC 2 个、TUIC 5 个和 Mieru 13 个。新回放生成了 40 个策略组和 171,144 条规则，未发现丢失的引用。测试未连接订阅内的代理服务器。

独立审查基线 `bfb5955b3e80ee7a6a9982ce6ab62faa54ed2d73`，首次候选 `342d85f94cb1d1a755a6bccdbb46c9106e58220d`。name_review_plan 发现 IPv6 校验接受地址外字符；review_routing 复现过滤后默认策略意外直连。修复候选 `ae47361e9fc478ab341973887f3d8049096ad17b` 已收紧地址验证，并在原默认代理失效时优先选仍可代理的成员。两位审查者均已复核关闭。回归包括合法和无效地址、嵌套策略组、原本明确直连的组和无法保留目标的分流规则。隔离 HTTP 验收命令为 `bash ops/fork/check.sh image`。

review_routing 随后复核 Safari 映射候选 `84c478800e12d0d770c1d90b74aa9f4ae15545cf`，提出显式禁用混合密钥交换与现代指纹冲突的问题。根据 Mihomo 的握手实现修正后，审查者复核 `0254b36b6f27a1492388ed1d946a7ef6e206d504`，确认冲突组合会被跳过，SNI、证书指纹、公钥及 short-id 仍保留。四个相关测试文件共 199 项通过。完整 CI 发现一条旧断言以官方已支持的 SSR `none` 作为拒绝样本，现使用不支持的 `aes-256-gcm` 核对拒绝分支，`none` 单独验证成功导出。[PR #10 和完整 CI](https://github.com/krus1995/subboost/pull/10) 记录最终源码和隔离镜像验收。发布后的原地址和 iPhone 握手待验证。

### Loon 规则冷启动

验收条件：生产镜像首次启动且无法访问 GitHub 时，「检查 Loon 配置」使用的已保存订阅地址可返回完整配置。广告规则、精确域名、域名后缀和 IPv4/IPv6 分流使用完整规则正文。镜像构建核对全部内置规则路径及内容；网络恢复时仍可更新规则。测试覆盖空缓存和上游超时。

[PR #10 部署](https://github.com/krus1995/subboost/actions/runs/42473075871) 的主机回执为 `ACTIVE`。随后从原订阅复现 HTTP 503，生产广告和 GitHub 规则接口均在约 20 秒后超时。离线候选从固定上游提交 `26cf4440307754d2c2f65cf2f0457c0ae814900f` 打包 95 份规则。模拟规则上游完全断网，将实际订阅的 Clash 输出回放，读取 93 份快照并生成 44 个节点、40 个策略组及 171,144 条规则，所有引用有效。原 Loon 地址须在后续发布后再验。

### 订阅链接格式菜单

验收条件：已保存订阅在首页结果对话框和管理页都有「复制链接」菜单。选择 Clash 或 Loon 即复制对应的持久地址，客户端访问时按保存的配置生成正文。页面不要求手动检查或下载配置。菜单、复制反馈和格式选择不推挤卡片，在窄屏上可操作。已有地址、二维码、其他已支持的下载操作及链接重置继续可用。

已用本机 Chromium 和合成订阅验证首页结果对话框与管理页的「复制链接」。在 390 和 1440 像素宽度下，展开菜单和复制后，卡片及对话框的位置、宽高均保持一致。两种格式均写入了正确的剪贴板地址，复制及二维码操作没有请求配置。复制失败时可手动复制，关闭弹窗后键盘焦点回到「复制链接」。实际首页导入合成节点，在打开 Loon 预览前未请求规则；切换后自动生成，下载的文件含节点和分流规则。
