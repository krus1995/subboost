# 定制功能记录

首次接管使用上游 v2.11.0 的业务代码。仓库规则、上游合并和生产部署的实施进度见 [STATE.md](STATE.md)。

首次业务回归覆盖加密订阅读取。用户登录后读取自己已有的一条订阅，应用按所有者身份查询并解密配置、节点和来源。入口为 `GET /api/subscriptions/<id>`，涉及 `local/src/lib/subscription-service.ts`。隔离测试运行 `bash ops/fork/check.sh image`，生产核验使用受限会话，只记录通过或失败。

## Loon 完整配置

首页的「Loon」页签按当前编辑内容在浏览器生成配置并下载 `loon.conf`。已保存的订阅可在订阅链接对话框、管理页选择 Loon，检查配置、复制链接、下载或打开客户端。两种格式共用订阅 token；重置链接后，原来的 Clash 和 Loon 地址都失效。

服务端通过 `GET /api/subscriptions/<token>/loon.conf` 读取同一条加密订阅的节点快照、配置和流量信息。已有数据库无需迁移。公开读取只使用保存的节点，内置规则来自项目当前使用的 MetaCubeX 规则仓库。匿名预览通过 `GET /api/loon/rules?path=...` 读取受支持的公开规则文件，节点和密码保留在浏览器中。规则读取失败返回 503，以便稍后重试。

首版支持 Shadowsocks、VMess、VLESS、Trojan、基础 Hysteria2、HTTP(S) 和 SOCKS5 的已实现参数，支持原生手动选择与测速组。内置规则按原顺序展开，区分精确域名、域名后缀和 IPv4/IPv6 网段，用 `FINAL` 指定兜底策略。Loon 优先匹配请求域名，再匹配 IP。基础配置使用系统 DNS。自定义基础 YAML、第三方远程规则集、链式代理、仅远程节点提供者及不支持的协议参数会产生诊断。公开订阅遇到不兼容配置时返回 422。

与上游共享的代码包括节点命名、策略组成员与规则排序、保存设置的读取、订阅响应头、首页和管理页。平台专用生成器位于 `packages/core/src/generator/loon*.ts`。上游更新节点字段、模板或公开订阅接口后，运行以下检查。

- `npm run test:unit -- loon subscription-service.test.ts subscription-route-contract.test.ts subscription-link-dialog subscription-dashboard-surface` 核对导出内容、格式切换、失败诊断、缓存与 token 撤销。
- `bash ops/fork/check.sh source` 核对 lint、分支覆盖率、类型和构建。
- `bash ops/fork/check.sh image` 在隔离数据库创建两个合成节点，通过 HTTP 验证策略改名、更新后的分流目标及两种旧链接失效。

Loon 的远程配置导入和两类规则的优先级见[官方 URL Scheme](https://nsloon.app/docs/Scheme/) 和[官方规则说明](https://nsloon.app/docs/Rule/)。

两种导出共用节点、组成员和规则目标。使用系统 DNS 的 Loon 在域名请求上优先匹配域名规则。Mihomo 的默认模板使用 fake-IP，并按规则排列顺序匹配。如果域名和它解析到的 IP 分别命中不同策略，客户端可能给同一请求选出不同策略。自动测速的结果也取决于客户端实际测得的延迟。[Loon 规则优先级](https://nsloon.app/docs/Rule/) · [Mihomo 规则优先级](https://wiki.metacubex.one/en/config/rules/#priority)

同源对照可运行 `npm run test:unit -- loon-policy-parity.test.ts subscription-service.test.ts loon-node.test.ts yaml.test.ts`。`bash ops/fork/check.sh image` 会通过真实订阅地址核对组成员、分流目标和链接重置。

Loon 导出会将节点名里影响配置解析的标点换成全角字符。例如，`[Airport] Tokyo, 01` 显示为 `［Airport］ Tokyo， 01`。转换后如有重名，会追加编号。节点筛选与排序仍按保存的原名执行，Loon 策略组和规则引用导出后的名称。回归检查见 `loon-names.test.ts` 和 `bash ops/fork/check.sh image`。
