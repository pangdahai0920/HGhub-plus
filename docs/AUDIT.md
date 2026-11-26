# 代码审计报告

审计对象：本仓库（HGhub 短剧客户端，Tauri 2 + React 19 + TypeScript）全部前端源码与 Rust 后端。
方法：三名审查者分别覆盖「Rust 后端 / 播放器组件 / 状态层与页面」，逐条给出文件行号与触发场景；随后由维护者**逐条复核**（对照代码与运行验证），只把复核通过的条目写进本报告。

- 复核后**推翻**的结论见文末「误报」，请不要按误报改代码。
- 「已修复」的条目都附带验证方式（单元测试 / 浏览器回归 / 类型检查）。
- 「待处理」是确认存在但需要设计变更、新增依赖或真实媒体环境才能安全改动的条目，已写明修法与风险。

---

## 一、已修复

| # | 位置 | 问题 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | `src/components/Feed.tsx` | 向下滑是「下一部短剧」，不是「下一集」 | 改成逐集滑片（deck）：一部剧的每一集各占一屏，滑完最后一集才进下一部；索引由「哪部剧第几集」反推，续播/选集/延迟展开都不会错位 | `pnpm test:feed`（40 项断言，含跨剧边界、续播、120 集长剧、安卓触摸、全屏对齐） |
| 2 | `src/components/Feed.tsx` | 容器尺寸变化（全屏/窗口缩放）会打断正在进行的翻页动画；连按翻页会因索引未提交而空转；剧集详情未到时下滑被吞 | 只在「当前屏真的移动」时对齐 `scrollTop`；翻页基准改为「正在滑向的目标」；被吞的下滑记为 `pendingAdvance`，详情到达后补上 | 同上（含连按、全屏进出、详情慢 2.5s 三个场景） |
| 3 | `src/pages/Search.tsx` | 搜索无请求序号：慢网络下「先搜都市再搜逆袭」，逆袭的结果会被都市的旧响应覆盖，标题与内容不一致 | 请求序号 + 只对同一次搜索的翻页去重；旧响应一律丢弃 | 类型检查 + 代码复核（无自动化场景，需可编排的慢接口） |
| 4 | `src/components/Panels.tsx` | 评论面板无请求序号：切集时第 1 集的评论会覆盖/追加到第 2 集 | 同上，按序号丢弃过期响应 | 类型检查 + 代码复核 |
| 5 | `src/pages/Profile.tsx` | 切到「空的收藏页」时 `loading` 永远停在 `true`，连空态都出不来 | effect 开头先清卡片与 loading | 类型检查 + 代码复核 |
| 6 | `src/store.tsx` | 存档只校验了 `history`：`likes/favs/follows/searchHist/volume` 被污染成 `null` 时，渲染期 `includes` 抛错 → 整屏白屏且下次启动仍复现 | 逐字段类型校验 + 上限收敛 + volume 夹到 0..1，坏值回退默认 | 类型检查 + 代码复核 |
| 7 | `src/components/VideoSurface.tsx` | `safeSeek` 的 350ms「就绪即播」兜底定时器没有登记，换源/卸载后仍可能对着旧 `<video>` 调 `play()` | 定时器进 ref，换源与卸载时统一清理 | 类型检查 + 播放器回归（`pnpm test:playback` 不受影响） |
| 8 | `src/components/Player.tsx` | ① 换源后 `playbackRate` 被浏览器重置为 1，按钮显示 2x 实际 1x；② seek 未收敛到 `duration-0.15`，拖到片尾会抛 `InvalidStateError`/卡死；③ 致命错误恢复计数耗尽后仍无退避地无限重连；④ 换源不清 `time/duration` | ① attach 与 `loadedmetadata` 时重新套用倍速；② 收敛 + `try/catch`；③ 超过 4 次只报错并 `stopLoad()`（拖动进度条会重新 `startLoad`）；④ 换源时清零 | 类型检查 + 代码复核 |
| 9 | `src-tauri/src/api.rs` | `api_category` 把前端传入的 `cate` 原样拼进路径：`../account/me` 可逃逸到同源任意 GET 接口（带 token），`?x=1` 可注入查询串 | `safe_cate()`：拒绝空/超长/`..`/`/\?#%`/控制字符，中文分类名照常放行 | 新增 Rust 单测 `category_name_cannot_escape_the_path` |
| 10 | `src-tauri/src/session.rs` | `session.json`（含登录 token）用 `fs::write` 直接覆盖：崩溃/磁盘满会留下半截 JSON，下次启动解析失败 =「随机掉登录」，旧会话同时丢失；Unix 下文件是 0644 | 临时文件 + `rename` 原子替换，Unix 下 `chmod 0600` | 新增 Rust 单测 `session_is_persisted_atomically` |
| 11 | `src-tauri/src/media.rs` | 响应硬写 `Accept-Ranges: bytes` 却从不处理 `Range`：`<video>` 拖动与 fMP4 的 `EXT-X-BYTERANGE` 会拿到 200 全量，行为未定义 | 不再声明 `Accept-Ranges`（服务端本来就只回整段）；真正的 Range 透传列在待处理里 | `cargo check` + 代码复核 |
| 12 | `src/components/ui.tsx` | `Img` 的 `ok/err` 不随 `src` 变化重置：一次失败后换新地址也永远显示灰块；空地址还会真的发一次请求 | 地址变化时重置状态；空地址不渲染 `<img>` | 回归场景「详情/封面晚到 2.5s」 |

> 第 12 条说明：Chromium 对 `src=""` 不会触发 `error`，所以「空地址 → 真封面」这条路径本身不会复现灰块；真正会复现的是「先失败一次（断网/404）再换地址」。此条按**硬化**处理，不宣称修掉了用户可见故障。

---

## 二、确认存在、暂未修复（需要设计变更/新增依赖/真实媒体环境）

按影响从大到小。修法都在「建议」里，改动量或风险较大，留待排期。

| 严重度 | 位置 | 问题与触发场景 | 建议 |
| --- | --- | --- | --- |
| 中 | `src-tauri/src/lib.rs:95-129`、`media.rs:354` | 自定义 `hg` 协议是「任意公网 URL 取数代理」，且把请求的 `Origin` 原样反射进 `Access-Control-Allow-Origin`。CSP 里刻意不给 `connect-src:`，但 webview 内任意 JS 仍能 `fetch("http://hg.localhost/seg?u=…")` 读到任意公网响应，等于绕过 CSP 的网络隔离 | ACAO 只回显允许的前端 origin；`/seg` 的 `u` 主机名与本次会话播放列表里出现过的 host 求交集 |
| 中 | `src-tauri/src/lib.rs:95-108`、`network_policy.rs` | `security_set(false)` 一个 IPC 同时关掉自定义协议的 Origin 校验与内网/保留地址拦截 → 一步降级为「本机/内网 SSRF 可用」 | 放宽操作加显式确认；或拆成「媒体兼容性」与「网络策略」两个开关，后者只允许收紧 |
| 中 | `src-tauri/src/net.rs:638`、`media.rs:379` | `resp.bytes()` 无大小上限，随后 `as_ref().clone()` 再复制一份：一个异常清单指向 1GB 文件就能打满内存（`panic=abort` 直接崩） | `Content-Length` 硬上限 + 分块累计；响应体改 `Bytes`/`Arc<Vec<u8>>` 避免整块复制 |
| 中 | `src-tauri/src/media.rs:44-52` | 分片缓存用「随机键」淘汰而非 LRU，图片缓存只按条数（240）不按字节：正在看的剧的分片可能被新封面挤掉，反复重下；240 张封面可达数百 MB | 换 `lru`/记录访问序号；图片缓存加总字节预算 |
| 中 | `src-tauri/src/playback_log.rs:128-202` | 开启诊断后每个分片请求触发 4~6 次同步磁盘写，并持有全局 `Mutex`（都在 tokio 任务里）：用户因为卡顿开诊断，诊断本身放大卡顿 | `mpsc` + 单消费者后台任务（`BufWriter`），`record()` 只做非阻塞投递 |
| 中 | `src-tauri/src/media.rs:195-208` | `PL_CACHE` 的 m3u8 永久缓存无 TTL，但分片 URL 带时效签名：签名过期后播放器一直 403，只能重启或清缓存；与 `Cache-Control: no-store` 语义矛盾 | 加短 TTL（VOD 可较长），直播清单不缓存 |
| 中 | `src-tauri/src/session.rs:110` | token 仍以明文 JSON 落盘（本次已改为原子写 + 0600，但没做加密/系统凭据库） | 接 `keyring`/stronghold 保存 token |
| 低 | `src-tauri/src/logging.rs` | `debug.log` 无上限、无轮转，`debug_log` 不限制长度 | 复用 playback.log 的轮转；入口截断 |
| 低 | `src-tauri/src/net.rs:298-310` | 错误串包含带签名的完整 URL 与上游响应体前 160 字符，会经 `debug_log` 落盘 | 对外错误统一 redact（已有 `redact_proxy` 可复用） |
| 低 | `src-tauri/src/api.rs:172` | `open_url` 只校验字面量 IP，不解析 DNS：`https://127.0.0.1.nip.io/` 可交给系统浏览器打开 | 复用 `network_policy::resolve_target` 再放行 |
| 低 | `src-tauri/src/net.rs:149-192` | 连接池 30s TTL 到期即**新建** Client：每隔 30s 丢一次 keep-alive 全部重握手 | 地址校验结果与连接池解耦（Client 复用） |
| 低 | `src-tauri/tauri.conf.json:52`、`.github/workflows/build-ios.yml` | iOS `developmentTeam` 是占位符；CI 把 ATS 全局关掉，与「只允许 HTTPS」的安全模型矛盾 | 团队 ID 由 CI 注入；ATS 收敛成 `NSExceptionDomains` |
| 低 | `src/store.tsx:160` | 每次状态变化都全量 `JSON.stringify` + 同步 `localStorage.setItem`（播放中每 5s 一次、拖音量每帧一次），配额错误被吞 | 按 key 分片 + debounce；配额失败降级并提示 |
| 低 | `src/store.tsx:289-307` | 单一 context，`value` 依赖整个持久化状态：任一写入都会让所有 `useStore()` 消费者重渲染（含 1500 行的 Feed 与整个 deck） | 拆 context 或改 `useSyncExternalStore` + selector |
| 低 | `src/components/VideoSurface.tsx:355` | `timeupdate` 每帧回灌父层 `setTime`，4Hz 全树重渲染 | 进度改订阅式，只让进度条/时码重渲染 |
| 低 | `src/html.ts:137-149` | 兼容模式（关闭严格安全）退化为 `USE_PROFILES:{html:true}`，放弃显式标签白名单（CSS 注入/界面伪装，非脚本执行）；正文链接统一 `target=_blank`，中键点击绕过 React 拦截 | 兼容模式保留白名单，仅放宽 data-*；链接改由 `onAuxClick` 统一交 `openUrl` |
| 低 | `src/App.tsx:241-249` | 安卓返回键顺序与注释相反：先退全屏再关面板 | 把 `runBack()` 提到 `fs` 之前 |
| 低 | `src/App.tsx:264` | 全局禁用右键菜单，桌面端在输入框里无法右键粘贴 | 只挂到播放器容器，或放行 `input/textarea/contenteditable` |
| 低 | `src/App.tsx:111` | 全局数字键切 tab 会清空导航栈：焦点在按钮上按 `2` 会把正在看的播放页关掉 | 排除 `BUTTON/A/SELECT/[contenteditable]` |
| 低 | `src/pages/Profile.tsx:24` | 收藏/历史只取前 12 条且无「查看全部」提示；「清空历史」按钮的显示条件是卡片加载成功 | 分页或提示；按钮条件改 `history.length > 0` |
| 低 | `src/pages/Posts.tsx:33` | 列表加载失败被 `catch {}` 吞掉，界面显示「暂无内容」且无重试 | 与 ChannelPage 一致的 `err + Empty action` |
| 低 | 多处 | 纯图标按钮缺 `aria-label`（搜索清空、CloseBtn、登录关闭）；登录表单缺 `label`/`autoComplete`；Sheet/Modal 无 `role="dialog"`/Esc | 补齐无障碍属性 |
| 低 | `src/components/cards.tsx`、`src/pages/*` | 卡片未 memo、`onOpen` 内联、瀑布流无限追加（无窗口化） | `memo` + 稳定回调；长列表窗口化 |

---

## 三、复核后判定为误报 / 不适用

| 结论 | 说明 |
| --- | --- |
| 「静音时音量滑杆不可用」不成立 | `PlayerControls` 的滑杆 `onChange` 走 `setVolume()`，而 `store.setVolume` 在 `volume > 0` 时会自动 `muted=false`，拖动即可恢复声音 |
| 「`useAsync` / `usePaged` 的竞态」不构成线上问题 | 两个 hook 的代数竞态描述属实，但全仓库没有任何调用方（死代码），不影响运行；如需保留建议按 runId 修 |
| 「严格模式清洗可被绕过」未确认 | 严格模式是「DOMPurify 白名单 → 二次净化」，禁 `on*/style/svg/math`，图片强制走本地代理，链接点击经 `handleArticleClick` + `abs()` 只放行 http(s)；未发现可利用路径 |
| 「`api_feed`/`api_search` 存在注入」不成立 | 两者分别走固定 query 与 `form_urlencoded`，只有 `api_category`（已修）是裸拼接 |

---

## 四、其它观察（非缺陷，供参考）

- `Feed` 的 `kind="post"` 分支（吃瓜帖复用播放器界面）当前没有任何调用方：`store` 里保留了 `feedKind` 字段但没人传 `"post"`。属死代码，删掉可简化约 80 行；保留则是给未来「帖子进信息流」留的口子。
- 前端产物单包约 925KB（gzip 286KB），其中 hls.js 占大头。Tauri 本地加载对首屏影响不大，若将来做 Web 端再考虑拆包。
- `pnpm test:playback` 依赖 ffmpeg 生成 HLS 夹具；`pnpm test:feed` 不依赖网络与媒体，CI 里已挂到 playback 流水线。
