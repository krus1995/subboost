# SubBoost 主机接管

服务器端使用 Docker Compose、Python 3.9 以上、GnuPG、curl 和 systemd。所有命令均在已经核对 SSH 主机公钥的目标服务器以 root 执行。GitHub 上传的压缩包中只有应用制品，服务器包装器单独安装。轮换前一版包装器时，先等当前 systemd 发布结束。

## 核对正在运行的实例

```bash
hostname
docker version
docker compose version
docker ps --format '{{.Names}} {{.Image}} {{.Ports}} {{.Status}}'
df -h
free -h
```

在下面的命令中，把 APP、DB、CRON 设为上一步辨认出的容器名。保留输出作为现场基线。数据库卷、配置文件和 Tunnel 网络都使用实际值。

```bash
for c in "$APP" "$DB" "$CRON"; do
  docker inspect -f '{{.Name}} {{.Image}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} {{index .Config.Labels "com.docker.compose.project.working_dir"}} {{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c"
done
docker inspect -f '{{json .NetworkSettings.Networks}}' "$APP"
docker inspect -f '{{json .Mounts}}' "$DB"
docker port "$APP" 3000/tcp
docker exec "$DB" sh -ec 'psql -XAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select system_identifier from pg_control_system()"'
docker exec "$DB" sh -ec 'psql -XAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select current_database(), current_user, version()"'
type -a subboost
systemctl list-timers --all
rg -l 'subboost|ghcr.io/subboost' /etc/cron.d /etc/crontab /var/spool/cron/crontabs /etc/systemd/system || true
```

从现有 cloudflared 连接器或 Cloudflare 控制台核对目标域名的 ingress 规则、实际 origin、连接器网络，以及同一 Tunnel 上需要比对的其他入口。仅把网络、别名、访问结果和路径写入项目记录。逐项确认 SubBoost 官方自动更新任务；对查实为本项目专用的 systemd timer 使用 `systemctl disable --now <确认的 timer>`，在对应 crontab 中仅移除已核实的更新行。记录原配置的位置和摘要。旧更新器可能覆盖快照内的 Compose 和管理脚本，必须在演练前处理。

如果现有 app 手工连入 Tunnel 网络，把该网络和 ingress 依赖的别名写入同一个 Compose 项目的最后一个 override，保留原 Compose 文件次序。同一项目保留已运行的 db 和 cron。核对 `docker compose … config` 的本地解析结果，避免将包含密钥的配置输出到日志。发布包装器会检查 Compose 重建后能否保留必要网络和别名。

首次接管还要核对最终生效的 `services.app.image`。正式 `.env` 只写一条 `SUBBOOST_IMAGE` 赋值，部署进程的环境中应清除同名变量。旧安装器可能让 app 优先读取 `SUBBOOST_CANDIDATE_IMAGE`。遇到这种配置，先保存原 Compose 文件，再让 app 的镜像字段读取 `${SUBBOOST_IMAGE:?set SUBBOOST_IMAGE}`。在 root 受限进程内比较修改前后的渲染结果，核对仍选中预期镜像，其他字段一致。然后重新运行预检和首次恢复演练。

预检用临时的 0600 文件替代 Compose 插值所用的 `--env-file`，检查渲染结果是否只改变 app 的镜像。服务自己声明的 `env_file` 仍按原路径读取。若有服务直接或通过符号链接读取正式插值文件，临时副本无法反映替换后传入该服务的变量。预检会在停写前报告服务名。请为该服务单独配置只包含所需变量的环境文件，再运行预检。

激活时包装器原子替换正式 `.env`，再用正式路径渲染并核对完整模型，通过后才重建 app。如果这一步报告模型不一致，正式 `.env` 已写入目标引用。按下文 `ACTIVATING` 阶段的步骤核对现场并向前修复。

## 安装与配置

从审查过的工作树传送 `ops/fork/` 后运行 `bash ops/fork/install-host.sh`。该命令创建 root 独占的配置、上传、回执、备份目录和一份本机备份加密密钥。将 `/etc/subboost-fork/backup.key` 单独保存在已获授权的受限密钥存储中。丢失该文件将无法解密备份。

首次配置时用 `test -e /etc/subboost-fork/host.json || install -m 600 /dev/null /etc/subboost-fork/host.json` 创建文件，再用服务器上的编辑器填写。字段示例中的值需要替换为上一步的现场值。

```json
{
  "project": "<实际 Compose 项目>",
  "projectDir": "<绝对路径>",
  "composeFiles": ["<第一个绝对路径>", "<其余实际 override 路径>"],
  "envFile": "<项目目录内实际 .env>",
  "dbNetwork": "<app 与 db 共用的实际 Docker 网络名>",
  "dbVolume": "<实际 PostgreSQL 数据卷名>",
  "dbSystemId": "<pg_control_system() 返回值，保留全部数字>",
  "dbUser": "<实际所有者>",
  "database": "<实际数据库名>",
  "localUrl": "http://127.0.0.1:<正式入口端口>",
  "candidatePort": 3109,
  "trustProxyHeaders": "<当前 TRUST_PROXY_HEADERS 的字符串值>",
  "appNetworks": {"<实际网络名>": ["app", "<需保留的稳定别名>"]},
  "tunnelContainer": "<连接器容器名，主机进程使用 null>",
  "tunnelOrigin": "<实际 http origin>",
  "otherIngress": [],
  "businessCredentials": "/etc/subboost-fork/business.json"
}
```

候选端口用 `ss -ltn` 核实空闲后填写；容器转发只绑定回环地址。配置中列出 app 的全部网络，各网络下只填重建后需要保留的别名。Docker 生成的旧容器 ID 每次重建都会变。主机进程型 Tunnel 使用现场核实的回环端口。容器型 Tunnel 必须通过与 app 的共享网络访问持久别名，或者在 host 网络中访问回环端口。其他 ingress 有可读健康地址时逐项填入。

`business.json` 使用 root:root、0600。填写已有可解密订阅的 `subscriptionId`，以及对应管理员的 `session`（仅 cookie 值）或受控账号的 `username` 与 `password`。生产发布在停写前登录一次，后续检查复用这次会话。用户名密码登录会更新该账号的上次登录时间。独立 `preflight` 只做健康与身份检查。交互式业务预检可在部署源目录用 `bash ops/fork/smoke.sh https://subboost.krus1987.kdns.fr --business /etc/subboost-fork/business.json`。

确认原管理脚本是现场记录的普通文件后，保存原件与摘要，并将管理员平时调用的命令指向 fork 包装器。下面以实际入口为 `/usr/local/bin/subboost` 为例。若实际路径或符号链接不同，先记录调用链，再在已核实的项目入口替换。已存在备份时保留第一份。

```bash
manager=/usr/local/bin/subboost
test "$(realpath "$manager")" = "$manager"
test -f "$manager"
if ! test -e /etc/subboost-fork/manager.before-fork; then
  install -m 600 "$manager" /etc/subboost-fork/manager.before-fork
  sha256sum /etc/subboost-fork/manager.before-fork > /etc/subboost-fork/manager.before-fork.sha256
fi
install -m 755 /usr/local/lib/subboost-fork/fork-manager.sh "$manager.next"
mv -T "$manager.next" "$manager"
cmp "$manager" /usr/local/lib/subboost-fork/fork-manager.sh
subboost doctor
```

## 演练与首次接管

首次发布前先单独执行一次恢复演练。该操作会短暂停止旧 app 和 cron，保留原数据库。预检必须先通过。

```bash
subboost-fork-deploy preflight
unit="subboost-rehearsal-$(date +%s)"
systemd-run --unit="$unit" -- /usr/local/sbin/subboost-fork-deploy rehearse
journalctl -fu "$unit"
systemctl show "$unit" -p Result -p ExecMainStatus
cat /var/lib/subboost-fork/rehearsal.json
```

演练会给旧镜像打本地恢复标签，加密保存实际 .env、Compose 文件、主机设置和数据库归档，检查归档全部数据段，恢复到唯一命名的新库，比对 schema、授权、计数和迁移历史，然后用旧镜像默认启动命令读取该库中的加密订阅。恢复后的旧 app、旧 cron、本机以及公网读取均须通过。基础设施 PR 可以先合并，保持仓库变量 `FORK_DEPLOY_ENABLED=false`，让 main 构建制品。收集演练回执、其他容器与 Tunnel 入口状态后，在仓库设置 `FORK_DEPLOY_ENABLED=true`，再发起首次部署。env、镜像或原数据库身份在首次接管前漂移时需要重做演练。首次候选失败后若已经还原到演练库，旧站虽恢复可用，但正式库的 OID 已换成恢复库的 OID。此时重新执行上面的 `rehearse`，再重试原制品。

构建机和服务器的 Docker 可以使用不同的镜像存储方式。发布清单中的 `imageId` 来自构建机，`configDigest` 和 `manifestDigest` 分别是同一份 OCI 归档的镜像配置和清单摘要。服务器校验归档中的标签、数据块、平台和源码版本，加载后把 Docker 返回的本机 ID 记为 `productionImageId`。检查实际容器、重试、恢复和清理时使用这个本机值。Actions summary 会同时列出构建和生产 ID。

部署由 runner 选择当前 main 的制品。受控 `prepare`、`submit`、`status` 使用工作流中的参数。管理员常用命令如下。

```bash
subboost status
subboost backup
subboost logs
subboost update
subboost-fork-deploy status "$SHA"
journalctl -u "subboost-fork-$SHA-$RUN_ID-$ATTEMPT"
```

`subboost backup` 在线生成加密备份并验证归档，单独手动备份由管理员管理。每次发布另做实际停写备份及隔离恢复。最近十个成功部署保留备份，最近两个保留制品，首次演练和失败现场单独保留。`subboost update` 从服务器已经登记的制品重试当前 main。缺少制品时从 fork 的部署工作流重试已验证构建。生产收件目录不接收包装器、自定义命令或可执行 SQL。

## 读取失败回执与恢复

### 手动重启

旧管理脚本的交互菜单和 `logs <服务>` 已换成上面的入口。`logs` 查看 app 和 cron，`status` 与 `doctor` 同时检查本机和公网。替换后的命令省去了原 `restart` 的 `--remove-orphans`，管理员可按下面的步骤重启已核对的容器。先查询当前回执与 systemd 发布状态。维护过程中只使用当前发布任务，避免其他操作启动 app 或 cron。

```bash
export APP CRON
flock -n /var/lib/subboost-fork/deploy.lock bash -ceu '
  test "$(docker inspect -f "{{.State.Running}}" "$APP")" = true
  test "$(docker inspect -f "{{.State.Running}}" "$CRON")" = true
  docker stop "$CRON"
  docker restart "$APP"
  python3 -B /usr/local/lib/subboost-fork/smoke.py https://subboost.krus1987.kdns.fr --wait 300
  python3 -B /usr/local/lib/subboost-fork/smoke.py https://subboost.krus1987.kdns.fr --business /etc/subboost-fork/business.json
  docker start "$CRON"
'
subboost doctor
```

锁被其他任务占用时，命令直接退出。如果 app 或业务检查失败，维持 cron 停止状态，待 app 修复并完成业务验证后再启动。

### 发布故障

先查 `subboost-fork-deploy status "$SHA"`，核对 `unit`、`phase`、`backup`、`oldImageId` 和 `recoveryRequired`。对照 `journalctl -u "$unit"`、`docker ps -a`、`backup.json` 以及实际数据库卷和 OID。SSH 断开后继续查询同一 SHA。只有进程退出并留下待处理阶段时才进入人工恢复。

候选迁移失败时，脚本停止候选，核对新旧库身份、加密归档摘要和停写状态，把经过恢复与业务验证的独立库改为原名。迁移失败的库另留为 `sbfailed_…`，其名称和 OID 写入备份目录。旧 app 和 cron 用原镜像启动。该过程清除失败迁移新建的对象。保持加密备份、旧镜像和失败库，直到管理员核实实际结果。

若该阶段发生主机重启或恢复失败，保留停写状态。恢复步骤如下。

1. 读取备份目录中的 `backup.json`，在数据库容器内查询 `SELECT oid, datname FROM pg_database` 和 `SELECT system_identifier FROM pg_control_system()`，确认原库、演练库及数据卷与回执一致。逐项核对 `sha256sum "$backup/db.dump.gpg" "$backup/config.tar.gpg"`。解密检查使用 `gpg --batch --pinentry-mode loopback --passphrase-file /etc/subboost-fork/backup.key --decrypt "$backup/config.tar.gpg" | tar -tf -`。原配置已保存在这个归档中。
2. 确认正式入口和 cron 仍然停写，仅停止本次回执拥有的候选和保留 IP 用的容器，核对两库都无客户端连接。如果任一库的 OID 或备份来源不符，保留现场。已进入 ACTIVATING 的情况按下一段处理。
3. 若演练库仍完整且 OID、所有者、schema 和记录数均匹配，用一笔事务将迁移失败库改为新的唯一诊断库名，并将此次已验证的演练库改为记录的正式库名。若改名事务已提交，通过 OID 辨认新旧库，直接核对结果。演练库不存在时，按 `production.py` 中 `Site.backup` 的 `createdb --template template0` 及 `pg_restore --exit-on-error --no-owner --no-privileges --dbname` 路径重新建唯一隔离库，先完成校验。恢复目标必须是已记录的空隔离库。
4. 核对原 .env 和所有 Compose 文件的实际摘要、原 app 的 image ID。用 `docker start "$APP"` 启动原容器。验证本机正常、Tunnel origin 和公网解密业务，再 `docker start "$CRON"`。确认正常 cron 周期后，运行 `subboost-fork-deploy reconcile "$SHA"` 重新核验现场并解除接续阻塞。

从 ACTIVATING 起保留现有数据库的全部写入。先核实当前正式容器与回执中的制品，修复实际故障并运行本机、域名和业务检查。缺少与当前新旧镜像及迁移摘要匹配的兼容证明时保留新镜像。需要数据库还原时，在获得对恢复时间点及写入损失的单独授权后处理。恢复原服务或继续运行目标版本且现场验证通过后，再执行 `reconcile`。候选迁移中断后，这个命令会核对当前库 OID、完整 schema 摘要、迁移和数据计数、备份摘要。激活后退回旧镜像的情形需要单独的兼容性或获授权恢复证明，包装器保持阻塞。
