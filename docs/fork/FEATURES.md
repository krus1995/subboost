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

## 订阅源导入与自动刷新

首页手动导入和管理页手动刷新可以连续使用，每次操作只用一种客户端标识获取订阅正文。上游拒绝请求或限流时，页面显示本次错误。定时刷新对同一地址在 6 分钟内最多发一次 HTTP 请求，多条订阅共用地址时也遵循这个间隔。自动请求成功、失败或超时都会占用这次访问机会。手动请求不占用自动刷新的访问机会。

同一地址的流量信息从正文响应头读取。自动刷新时，单独配置的流量地址和重定向目标也受访问间隔限制。访问记录复用 PostgreSQL 的 JobLeaseLock 表，按地址摘要区分，重启后继续生效。自动刷新遇到这个限制时会保留已保存的节点。Clash 的 proxy-provider 由客户端自行下载原始订阅。

与上游共享的入口包括 server-core 的订阅导入与节点刷新、local 的 HTTP 传输和自动更新任务。回归命令为 `npm run test:unit -- source-import refresh-node-snapshot subscription-service auto-update-service`。运行 `bash ops/fork/check.sh image` 会在隔离数据库中，通过模拟上游的实际 HTTP 计数核对请求次数。

首页快捷模式和高级模式共用来源编辑器。导入成功后，修改标签或节点命名模板并点「完成」，编辑器使用已导入的节点更新名称及配置引用，保留节点数和流量信息。修改订阅地址后点「完成」仍会导入新地址。

与上游共享的代码包括来源编辑器、浏览器中的订阅导入和节点名称引用。回归命令为 `npm run test:unit -- source-actions-naming sources-section input-section node-name-references`。

## 按来源标签分组、合并订阅规则

在首页打开一个导入源的「高级编辑」，填写「来源标签」。多个公益订阅可以填同一标签。只要来源标签有不同的值，就能在自定义分组里按节点筛选，同时指定来源标签和地区。例如，建一个「主机场 JP」和一个「公益 JP」，两个组都选日本，分别勾选对应标签。修改标签使用已导入的节点。未填写标签或所有标签相同的订阅沿用原有分组逻辑。

在来源的高级编辑中启用“使用此来源的规则”，SubBoost 会从同一次响应或本地文件读取节点、原策略组和规则。在高级模式的“规则管理”中，导入规则与 SubBoost 的规则按已有业务分类汇总。每个原分类显示规则数、有效数及最多三条样例，可以分别修改归属分类和出口，不必展开数千条规则。快捷模式也提供同一套分类管理。

分类依据原策略目标名称，不根据规则中的域名猜测。Google、Apple、Scholar、MyTVSuper、Epic 等归入已有对应分类。未知分类归入“非中国”，可改到其它已有分类。同名自建分类优先复用。未启用的分类保留归属，默认使用已存在的节点选择、非中国、漏网之鱼或自动选择组；这些组都不可用时使用第一个有效节点，界面显示实际出口。不会创建来源分类或来源代理组。

出口独立于分类。原来明确直连、拒绝以及原策略默认的直连或拒绝动作仍然保留。直接引用节点的规则仍使用该来源内的节点，兼容导出失去该节点时提示错误。已保存的显式出口绑定继续生效，原目标的上层绑定仍可传到子策略。用户可在出口下拉中指定已有组或动作，界面在旁边显示有效结果。修改分类、出口和顺序均使用已导入数据，不请求订阅地址。

多个来源按标签分块排序，同标签的 URL 或文件按输入顺序处理。同一匹配条件只保留优先来源的第一条，覆盖后续来源或 SubBoost 内联规则中同条件的出口。规则类型、完整条件和影响匹配的选项共同参与比较，保留关键字末尾的点以及 no-resolve 的区别。全部导入规则在 SubBoost 规则之前，末尾只使用优先来源的兜底。旧配置里 SubBoost 块的位置不再改变这个优先级。

Clash 保留已有远程规则集引用，服务端无法逐条比较客户端随后下载的内容。因此导入规则也会先于规则集中的更具体条件命中，包括宽泛的域名后缀或关键字规则。Loon 展开规则集后会移除与前面规则真正相同的条件，其域名优先规则仍按客户端行为执行。界面将被导入规则覆盖的 SubBoost 内联规则和原兜底标为不导出；下表的行号表示 SubBoost 设置顺序，不是合并后的配置行号。

正式导入和刷新使用完整 Clash 配置，支持内联域名、IP 网段、GEOIP 和进程规则。遇到暂不支持的规则或依赖远程提供者的策略组时会提示原因。导入或刷新失败的来源保留上次有效的节点和规则，其它来源可独立更新。Loon 的域名匹配优先级和节点兼容限制见上文。

来源标签、规则快照、分类映射 ruleCategories、出口绑定 ruleTargets 和来源顺序保存在现有加密配置中，无数据库迁移。前端预览和已保存订阅使用同一套分类与规则编译器。上游交叉区域包括来源编辑器、规则管理、保存与刷新、Clash 和 Loon 的分组与规则导出。

- `npm run test:unit -- source-label-routing source-rules source-rules-editor source-rule-order-preview source-actions-rules saved-sources auth-handoff editing-subscription-loader use-subscription-link` 检查来源筛选、分类汇总、优先级、保存重开和出口绑定。
- `bash ops/fork/check.sh image` 用模拟订阅核对保存后的分类、来源调序、同条件唯一出口、文件与阅后即焚快照，以及部分刷新失败后的两端导出。

## 来源阅后即焚

首页快捷和高级模式在单个 URL 的高级编辑里提供「阅后即焚」开关。首次导入只尝试一次，失败不自动或手动重试同一来源地址。已经成功导入的来源开启后沿用节点；更换为新地址可以导入一次。导入只使用正文响应，不额外访问流量地址或使用流量 User-Agent。保存、重新打开与登录草稿都保留设置及已尝试地址。

手动刷新、定时刷新和客户端读取配置均使用保存的节点、规则及流量快照。普通来源继续更新，共享重名节点仍保留阅后即焚来源的旧连接。此设置关闭客户端 proxy-provider 直连，避免客户端再次请求原始地址。字段保存在现有加密来源配置中，无数据库迁移。

与上游共享的区域包括来源编辑器、导入状态、保存与恢复、节点刷新及两端的 provider 导出。回归命令为 `npm run test:unit -- source-actions-read-once refresh-node-snapshot saved-sources proxy-providers auth-handoff sources-section input-section editing-subscription-loader`。`bash ops/fork/check.sh image` 通过模拟 HTTP 计数核对首次导入后不再访问正文和流量地址、混合来源手动及定时刷新，以及 Clash 和 Loon 的快照导出。

## 从本地文件导入订阅

在快捷或高级模式中，点「添加订阅/节点源」，选择「本地上传 / YAML」。也可以把已有来源切换为 YAML。选择电脑上的 Clash 配置、节点链接文本或 Base64 订阅文件，然后点「导入此源」。在高级编辑弹窗选文件后，点「完成」即可导入。需要文件内的策略组和规则时，在高级编辑中打开「使用此来源的规则」。

浏览器读取所选文件。保存时，正文、节点和已启用的规则快照随订阅存入现有加密配置。手动和定时刷新保留上传的快照，同一订阅里的普通 URL 仍可更新。重新选择文件即可替换本地来源。

与上游共享的代码包括来源编辑器、订阅保存与恢复、节点合并和刷新。运行 `npm run test:unit -- local-source-file source-actions-read-once saved-sources refresh-node-snapshot` 检查文件读取和快照。运行 `bash ops/fork/check.sh image` 核对保存后的订阅与刷新结果。
