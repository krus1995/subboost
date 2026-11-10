# 定制功能记录

首次接管使用上游 v2.11.0 的业务代码。仓库规则、上游合并和生产部署的实施进度见 [STATE.md](STATE.md)。

首次业务回归覆盖加密订阅读取。用户登录后读取自己已有的一条订阅，应用按所有者身份查询并解密配置、节点和来源。入口为 `GET /api/subscriptions/<id>`，涉及 `local/src/lib/subscription-service.ts`。隔离测试运行 `bash ops/fork/check.sh image`，生产核验使用受限会话，只记录通过或失败。

## Loon 完整配置

保存订阅后，在首页结果对话框或订阅管理页点「复制链接」，再选 Clash 或 Loon，即可把对应地址粘贴到客户端。复制时只写入地址。客户端读取 `config.yaml` 或 `loon.conf` 时，服务端按同一份已保存配置生成相应格式。两个地址共用一个访问凭据（token），重置后原地址同时失效。选择「更多方式」可以扫码、查看地址或下载文件。首页编辑器切到 Loon 页签后，会根据当前编辑内容自动生成预览；下载的 `loon.conf` 包含完整配置。

服务端通过 `GET /api/subscriptions/<token>/loon.conf` 读取同一条加密订阅的节点快照、配置和流量信息。已有数据库无需迁移。公开读取只使用保存的节点，内置规则来自项目当前使用的 MetaCubeX 规则仓库。匿名预览通过 `GET /api/loon/rules?path=...` 读取受支持的公开规则文件，节点和密码保留在浏览器中。应用随镜像提供全部内置规则。冷启动时两个接口直接读取本地文件，后台逐项刷新已经请求的规则，成功更新后缓存 24 小时。上游超时、返回空文件或规则语法无效时保留最近可用的正文。新进程从镜像快照开始，Clash 客户端会独立更新远端规则。

打包文件位于 `local/public/loon-rules/`，清单记录上游提交和各文件的 Git blob 摘要。`node local/scripts/verify-loon-rule-snapshot.mjs` 核对白名单和摘要，`bash ops/fork/check.sh image` 在无公网的内部网络首次读取含广告和私有网络规则的已保存订阅，并逐条对照域名与 IP 规则。

首页与已保存订阅都按 Loon 能表达的协议及参数导出。支持 Shadowsocks、ShadowsocksR、VMess、VLESS、Trojan、AnyTLS、Hysteria2、WireGuard、HTTP(S) 和 SOCKS5。VMess 和 VLESS 支持 TCP、WebSocket 和可保留 Host、路径的 HTTP；Hysteria2 可保留 Salamander 混淆。兼容导出把通用 `safari` 和 `ios` 指纹映射到 `safari-ios18`。Reality 允许混合密钥交换时，通用 Safari 和 Chrome 可分别使用 `safari-ios-26` 和 `chrome147`。如果源配置同时指定这类新版指纹并要求禁用混合密钥交换，Loon 缺少单独的关闭选项，导出时会提示跳过。配置注释记录发生转换的节点序号和目标指纹。XHTTP、gRPC、HTTPUpgrade、TUIC、Mieru 及无法保留的 TLS 客户端指纹会列入跳过清单。Loon 配置注释记录数量、原节点序号及原因，首页的 Loon 预览也会显示这些信息。原订阅和 Clash 节点保留原样。[Loon 节点参数](https://nsloon.app/docs/Node/) · [Sub-Store 指纹映射](https://github.com/sub-store-org/Sub-Store/commit/e08f1b1)

策略组支持手动选择、测速、可用性回退和轮询负载均衡。组可以嵌套。过滤后失去代理出站的组会从配置及其父组移除。分流规则按原顺序展开，保留精确域名、后缀及 IPv4/IPv6 网段，以 `FINAL` 指定兜底。无可导出节点、显式规则失去目标、无法表达的基础 YAML 或第三方远程规则集，会让该地址返回 HTTP 422。Loon 使用系统 DNS，优先匹配请求域名，再匹配 IP。[Loon 策略组](https://nsloon.app/docs/Policy/policygroup/)

与上游共享的代码包括节点命名、策略组成员与规则排序、保存设置的读取、订阅响应头、首页和管理页。平台专用生成器位于 `packages/core/src/generator/loon*.ts`。上游更新节点字段、模板或公开订阅接口后，运行以下检查。

- `npm run test:unit -- loon subscription-service.test.ts subscription-route-contract.test.ts subscription-link-menu subscription-link-dialog subscription-dashboard-surface` 核对导出内容、两种链接的复制、预览和失败提示，以及缓存和链接重置。
- `bash ops/fork/check.sh source` 核对 lint、分支覆盖率、类型和构建。
- `bash ops/fork/check.sh image` 在隔离数据库保存混合订阅，通过 HTTP 核对节点清单、策略组、全不兼容时的诊断及旧链接失效。

Loon 的远程配置导入和两类规则的优先级见[官方 URL Scheme](https://nsloon.app/docs/Scheme/) 和[官方规则说明](https://nsloon.app/docs/Rule/)。

两种导出共用节点、组成员和规则目标。使用系统 DNS 的 Loon 在域名请求上优先匹配域名规则。Mihomo 的默认模板使用 fake-IP，并按规则排列顺序匹配。如果域名和它解析到的 IP 分别命中不同策略，客户端可能给同一请求选出不同策略。自动测速的结果也取决于客户端实际测得的延迟。[Loon 规则优先级](https://nsloon.app/docs/Rule/) · [Mihomo 规则优先级](https://wiki.metacubex.one/en/config/rules/#priority)

同源对照可运行 `npm run test:unit -- loon-policy-parity.test.ts subscription-service.test.ts loon-node.test.ts yaml.test.ts`。`bash ops/fork/check.sh image` 会通过真实订阅地址核对组成员、分流目标和链接重置。

Loon 导出会将节点名里影响配置解析的标点换成全角字符。例如，`[Airport] Tokyo, 01` 显示为 `［Airport］ Tokyo， 01`。转换后如有重名，会追加编号。节点筛选与排序仍按保存的原名执行，Loon 策略组和规则引用导出后的名称。回归检查见 `loon-names.test.ts` 和 `bash ops/fork/check.sh image`。

## 订阅源只请求一次

首页导入、管理页手动刷新和定时刷新共用同一条限制：SubBoost 服务端对同一订阅地址在 6 分钟内最多发一次 HTTP 请求。这个时长沿用项目已有的最短自动刷新间隔。正文只用一种客户端标识请求；上游按标识返回不同节点时，导入本次响应中包含的节点。成功、拒绝、超时或正文解析失败都会占用本次访问机会。

同一地址的流量信息从正文响应头读取。单独配置的流量地址和重定向目标也受访问间隔限制。访问记录复用 PostgreSQL 的 JobLeaseLock 表，按地址摘要区分，重启后继续生效。遇到本地访问间隔限制时保留已保存的节点。这项限制适用于 SubBoost 服务端；使用 Clash 的 proxy-provider 配置时，由客户端自行下载原始订阅。

与上游共享的入口包括 server-core 的订阅导入与节点刷新、local 的 HTTP 传输和自动更新任务。回归命令为 `npm run test:unit -- source-import refresh-node-snapshot subscription-service auto-update-service`。运行 `bash ops/fork/check.sh image` 会在隔离数据库中，通过模拟上游的实际 HTTP 计数核对请求次数。
