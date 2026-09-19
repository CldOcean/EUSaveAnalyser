# 存档目录站点（apps/site）

存档目录页 + 上传/删除 API。**阶段 A 已完成**：网页上传、列表、排序、删除都能用，存储走 Cloudflare R2。

## 为什么是这个架构

部署目标是 **Cloudflare Pages**（静态站点 + Functions），但 Cloudflare 端有两条硬限制，决定了职责怎么分：

| 限制 | 后果 |
|---|---|
| Workers 运行时**没有文件系统** | 存档只能放对象存储（R2）或 KV/D1 |
| 免费版每次调用 **10ms CPU / 128MB 内存**，付费版 30s | **解析绝不能在服务端做** |

本项目的存档 `gamestate` 解压后是 **57.4 MB**，本机 Node 解析一次约 1.1 秒——远超 Workers 的限制。所以：

> **Cloudflare 只负责搬运（上传/列表/删除），解析放在浏览器里做。**

浏览器端解析是可行的：解析器是零依赖纯 TS，唯一要换的是 ZIP 解压——从 Node 的 `zlib` 换成浏览器原生的 `DecompressionStream('deflate-raw')`。

## 目录结构

```
apps/site/
├─ src/api.ts            API 逻辑（只用 fetch API，Workers 与 Node 都能跑）
├─ src/storage-r2.ts     R2 适配器（生产）
├─ src/storage-disk.ts   磁盘适配器（本地开发，目录结构与 R2 完全一致）
├─ src/dev-server.ts     本地开发服务器（零依赖）
├─ functions/api/        Cloudflare Pages Functions —— 按路径自动变成路由
│   ├─ saves.ts          GET 列表 / POST 上传
│   └─ saves/[id].ts     DELETE 删除 / PATCH 编辑
├─ public/               ★ 整个部署产物就是这一个目录（Pages 直接发布它）
│   ├─ index.html app.js style.css      目录页
│   ├─ viewer.html viewer-page.js viewer.js paint.js   查看页（见下）
│   ├─ page-theme.js                    背景/主题组件：目录页与查看页共用一份
│   ├─ eu4-parser.js paint.js           由 pnpm browser 从 TS 源码生成
│   ├─ assets/flags/{base,modded,colonial,colonial-modded}/   国旗（2,125 个文件）
│   ├─ assets/flags/mods/               ★ 本地专用，已 gitignore，**不会**上传
│   └─ 背景图/ wallpapers.json           背景图与它的清单
└─ test/api.test.ts      10 条 API 测试（跑的是磁盘适配器，与生产同一套 handler）
```

`assets/` 与 `背景图/` 就在 `public/` 里面（不再放在仓库根目录），这样**开发服务器和 Cloudflare 提供的是同一棵树**，中间不需要任何拷贝步骤。

## 本地运行

项目根目录有三个**双击即用**的启动器（都自带 `cd /d "%~dp0"`，在哪双击都行）：

| 文件 | 作用 |
|---|---|
| `启动网站.bat` | 启动本地服务并自动打开浏览器；若端口已被占用则直接开浏览器，不重复启动 |
| `生成查看页.bat` | 问你要存档路径（也可把 `.eu4` 拖进窗口），然后入库 + 解析 + 生成查看页 |
| `解析存档.bat` | **只解析不改动**：跑完整解析流程，控制台输出纯 ASCII 进度，中文详情写进 `tmp/parse-report.txt` 并用记事本打开 |

> 这三个 bat 的内部约定：**控制台只输出 ASCII，且不改代码页**。原因是 cmd 在 `chcp 65001` 下处理程序输出的 UTF-8 中文时会**提前终止批处理**（`§`/`£` 这类字符尤其容易触发），表现为"跑一半就停"。所以中文一律写入文件、由记事本显示。
> bat 文件本身必须是 **CRLF** 换行（LF 会让 cmd 错行解析），仓库里的三个都已按 CRLF 保存。

也可以手动跑：

```bash
pnpm site                    # http://127.0.0.1:8788
pnpm site -- --port 9000     # 换端口
```

> **必须通过这个地址访问，不要双击 `public/index.html`。**
> 前端用的是 ES 模块（`<script type="module">`），`file://` 下浏览器会以跨域为由拒绝加载它，
> 结果是页面能显示、**但所有按钮都没反应**。页面现在会自己检测这种情况并在顶部给出红色提示；
> 如果服务没在运行，1.5 秒后也会出现一条"界面脚本没有加载成功"的提示。

存储落在 `.dev-storage/`（结构与 R2 一致），未设 `UPLOAD_TOKEN` 时本地允许匿名写入。
端到端冒烟（需要服务已在跑；`--keep` 会把示例存档留在目录里，方便有个真实样例可看）：

```bash
node apps/site/test/smoke.ts --keep "存档示例/mp_俄罗斯1574_11_12.eu4"
```

## 部署到 Cloudflare（一次性配置）

1. **建 R2 桶**：Dashboard → R2 → 新建桶（例如 `eu4-saves`）。免费额度 10 GB。
2. **建 Pages 项目**：连这个 GitHub 仓库，配置：
   - Root directory：`apps/site`
   - Build command：**留空**（前端无构建步骤——`public/` 双击就能跑，发布的就是它）
   - Build output directory：`public`
3. **绑定 R2**：Pages → 该项目 → Settings → Functions → R2 bucket bindings → 变量名 **`SAVES_BUCKET`** → 选你的桶。
4. **设上传口令**：Settings → Environment variables → 新增 **`UPLOAD_TOKEN`**，值用一串长随机字符（`openssl rand -hex 24`）。
5. **自定义域名**：Pages → 该项目 → Custom domains → 添加你的域名（DNS 在这个 Cloudflare 账号里的话一键完成，会自动签证书）。没域名也能用 `xxx.pages.dev`。
6. 重新部署一次。打开站点 → 右上 ⚙ → 「上传口令…」填入同一串 → 之后上传/删除就通了。

> **不设 `UPLOAD_TOKEN` 时 API 是只读的**——这是刻意的安全默认值。公开站点上任何人都能调用 `/api/saves`，没有口令就只允许看，不允许传和删。

`functions/` 目录里的文件会**按路径自动成为路由**，所以 `/api/saves` 和 `/api/saves/:id` 不需要任何路由配置——这就是"Cloudflare 能识别到后端功能"的机制。

### 发布前先跑一遍闸门

```bash
pnpm verify:deploy
```

它按 Cloudflare 官方限制（[Pages limits](https://developers.cloudflare.com/pages/platform/limits/)：免费版 **20,000 个文件**、单个文件 **25 MiB**）检查 `public/`：

- 只算**会被发布的那批**（`assets/flags/mods/` 已在 `.gitignore` 里）——实测 **2,159 个文件 / 46.7 MB，占上限的 10.8%**
- 最大单文件 2.24 MB，离 25 MiB 很远
- 站点入口文件与国旗/背景图目录都在
- **页面真正会画出来的每一面旗都存在**：榜单前 15 名 + 曲线图例，实测 16 个 tag 全覆盖（动态生成的殖民地 tag 走 `colonial/` 合成旗兜底）
- 存档里 1,380 个 tag 有 395 个没有任何旗图，`verify:deploy` 会说明它们全是动态 tag 家族（`C*`/`D*`/`E*`/`K*`/`F*`/`PROV*`/`---`）——**没有一个是历史国家**，地图上它们按国家颜色上色，不会出现破图

> ⚠️ **用 git 部署，不要 `wrangler pages deploy public`**：`assets/flags/mods/` 那 14,550 个本地文件会被一起传上去，直接超过两万文件上限。走 GitHub 时它们根本不在仓库里，天然安全。闸门会提示这一点。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/saves?sort=&dir=` | 列表。`sort`：`uploadedAt`(默认)/`date`/`player`/`name`/`size`；`dir`：`desc`(默认)/`asc` |
| `POST` | `/api/saves` | 上传。**请求体是文件原始字节**（流式写入 R2，不缓冲），头部：`x-file-hash`(sha256，必填)、`x-file-name`(URL 编码) |
| `DELETE` | `/api/saves/:id` | 删除该存档及其全部产物 |
| `PATCH` | `/api/saves/:id` | 修改条目（`{name?, info?}`），留给查看页的"编辑信息"用 |

为什么用原始字节而不是 multipart：Workers 里 `request.formData()` 会把整个文件读进内存，而 `BUCKET.put(key, request.body)` 能直接流式转发。

为什么哈希由浏览器算：Workers 要算 sha256 必须先把整个文件读进内存；浏览器本来就有 `File` 对象，`crypto.subtle.digest` 顺手算了，还能**上传前就查重**。

## R2 里的对象布局

```
index.json                     目录索引（丢失/损坏时会从下面各份 meta.json 自动重建）
saves/<id>/original.eu4        原始存档
saves/<id>/meta.json           该存档的条目
saves/<id>/viewer/…            （阶段 C 之后）生成好的查看页
```
`<id>` = sha256 前 12 位，天然去重：同一份存档重复上传返回 **409**。

## 浏览器端解析（阶段 B，已完成）

`public/parser.js` 在**浏览器里**读出存档的自我描述，上传后立刻填进卡片：

- 只读 zip 里的 **`meta` 成员（约 3 KB）**，**完全不碰 57 MB 的 `gamestate`** —— 这就是它能跑在浏览器里的原因
- 自包含、无构建步骤、无依赖：自己走 zip 中央目录、用浏览器原生 `DecompressionStream('deflate-raw')` 解压、并按 `packages/eu4-parser/src/encoding.ts` 重实现了"字母流"字符串解码（标记 0x10–0x13 及各自 delta）
- 实测**约 7 毫秒**（真实 8.3 MB 存档），拿到：战役日期、玩家（含字母流编码的中文国名）、版本、DLC 数、模组数与模组名
- 解析失败不影响入库：文件已经存好，卡片显示「未解析」，之后可重试

`apps/site/test/meta-reader.test.ts` 会把**浏览器模块与 Node 解析器跑在同一份真实存档上逐字段比对**——这是这套实现唯一可信的验证方式（同一个 `meta`，两条完全独立的实现）。

## 查看页（阶段 C1，已完成）

目录页的「打开查看页」已可用。生成仍然在本地跑，因为这一步需要游戏本体的文件（`map/provinces.bmp`、`map/definition.csv`、`map/default.map`、`common/religions`、localisation）以及一次 57 MB 的解压——Cloudflare 的 Worker 既没有文件系统，也只有 10 ms CPU。

```bash
pnpm save:viewer <id> --save "path/to/xxx.eu4"          # 写本地 .dev-storage（与 R2 同构）
pnpm save:viewer <id> --save x.eu4 --api https://你的站 --token <UPLOAD_TOKEN>   # 传到线上 R2
```

流程：渲染时间线（约 5 秒，产出 10 个文件约 8 MB）→ 逐个 `PUT /api/saves/:id/artifact?path=viewer/…` 传进存储 → 记录标记为 `ready` 并写入 `viewer` 地址（即使本地直写，也会同时更新 `index.json`，否则列表会读到旧索引）。

站点通过 `functions/saves/[id]/viewer/[[path]].ts` 把 R2 里的产物流式送出（`cache-control: 86400`）。开发服务器同样按 `/saves/<id>/…` 映射到存储，而 `assets/`、`背景图/` 现在就在 `public/` 里，两边提供的是同一棵树。

端到端验证：`node apps/site/test/viewer-flow.ts`（上传 → 构建 → 站点提供 → 检查被引用的共享资源是否都能取到）。

**阶段 C2（已完成）**：时间线现在也能**完全在浏览器里**生成，所以"上传完就能看"不需要任何本地命令。

- `public/viewer-build.js` 在浏览器里产出**整个数据平面**——与离线构建的 `tmp/timeline/data.json` **38 个键逐一相同**，三张表格的 HTML 也逐字节相同（`test/viewer-build.test.ts` 断言的就是这件事，这是唯一可信的验证方式）
- 页面骨架、客户端脚本、画师都抽成了共享资产（`viewer.html` / `viewer.js` / `paint.js`）：离线生成器读同一份文件，所以两个宿主不可能长歪；`scripts/render-timeline.ts` 因此从 2,681 行缩到 1,403 行
- **背景与主题也是共享资产**（`public/page-theme.js`）：目录页 `import` 它，托管查看页在挂载播放器前 `await import` 并把导出挂到 `globalThis`，离线页则被剥掉 `export ` 后内联在播放器之前。三处读写的都是同一个 `localStorage['eu4analyser.settings']`，所以查看页顶部不再有自己的 ⚙ 设置面板——右下角那个 🎨 就是同一份实现（工具栏只留 旗帜 / 配色 / 分辨率）
- `public/viewer-page.js` 是托管查看页的引导程序（`/viewer.html?id=<存档id>`）：先查 IndexedDB 缓存，没有才请你选**两个**目录 → 下载存档 → 解压 → 解析 → 生成 → 交给播放器。缓存里存的是**解码后的地图**和**合并好的国名/宗教色**，所以只选一次
  - **① 游戏目录（必需）**：选到能看到 `map`、`common`、`localisation` 的那一层
  - **② 汉化 mod 目录（可选，但要中文国名就得选）**：例如 `…\steamapps\workshop\content\236850\2976470733`。选 mod 根目录或它里面的 `localisation` 文件夹都行
  - 合并顺序是「游戏目录在前、汉化 mod 在后」，后者覆盖前者——**顺序就是功能本身**：反过来的话所有国名都会退回英文，而页面其它部分毫无变化（`test/game-localisation.test.ts` 用真实文件断言了这一点：base 是 `England`，合并后是 `英格兰`）
  - 引导程序会打印读到的词条数与 `RUS→俄罗斯` 之类样例，这样选错目录当场就能看出来，不用等地图画完
  - 选错了不用清浏览器数据：查看页地址后面加 `?reset=1`（或点页面上那个「重新选择游戏目录 / 汉化目录」链接）就会忘掉缓存重选
  - 词条缓存带版本号（`TABLES_VERSION`）：只缓存了英文的旧记录会被忽略，所以这次改动后会自动再问一次
- 目录页的按钮不再置灰：有预生成页就打开它，没有就打开托管页
- `pnpm verify:player` 的执行器新增一节，确认宿主交过来的 facts 与三张表格真的进了页面

## 配色三模式（为"重新染色任何国家"这类模组而做）

模组会把宗主和属国画成同一个颜色，帝国和它的附庸在地图上糊成一团。查看页工具栏的
「配色」按钮在三种读法之间切换（选择记在 localStorage）：

| 模式 | 画什么 |
|---|---|
| **模组色**（默认） | 存档里的 `map_color`，即模组的结果。**属国从"成为属国那一天"起才变色**，在那之前画它自己的原色 |
| **原始色** | 每个国家都用游戏本体的 `color`，辨识度最高（存档里原色一直都在，模组只改 `map_color`） |
| **属国染色** | 属国跟随宗主颜色，但**明度上明显拉开**（宗主偏亮就压暗、偏暗就提亮，并带一点按 tag 的随机量，所以同一宗主的多个属国也互不相同） |

数据来源与边界（`packages/eu4-parser/src/subjects.ts`）：

- 属国关系来自存档的 `diplomacy/dependency` 账本，每条带 **`start_date`**，所以"何时开始变色"是查得到的
- **账本只保留现存关系**：已经结束的属国关系存档里没有。这不影响观感——模组在关系结束时会把原色还回去，所以**现在独立的国家，它的 `map_color` 本身就是原色**，画在整条时间线上天然正确
- **朝贡国不算属国**：`tributary_state`、`nahuatl_tributary` 这类按名字判定排除（实测模组也没有给它们染宗主色）；贸易联盟与结盟根本不在 `dependency` 里，天然不算
- 已知局限：同一国在本局里两次成为属国时，只保留最后一次的起始日期，更早那段会画成原色

两端实现（浏览器 `viewer-build.js` 与离线 `render-timeline.ts`）产出的 `colours` 对象由 `test/viewer-build.test.ts` 逐键比对，运行期由 `pnpm verify:player` 第 11 节验证按钮真的会换图（三种模式画出的帧各不相同）。

## 上传即生成（最新）

上传后不再只是解析：**同一段流程里就把时间线数据生成好并入库**，所以打开查看页变成秒开，也不再存在"有预生成页"和"没有预生成页"两类存档。

- 存的是**数据，不是页面**：`saves/<id>/viewer/data.json`（数据平面 + 三张表，约 2 MB）与 `viewer/raster.png`（底图，约 0.5 MB）。页面模板与客户端始终用站点上那一份共享文件——以后改进查看页，所有存档立刻生效，不会留下一堆冻结的旧副本
- 上传时多花约 10 秒（这是唯一变慢的地方），失败**不算上传失败**：存档已经存好，打开查看页时会重试并顺手补存
- 没选过游戏目录时无法生成：卡片保持「在浏览器中生成」，打开一次（选两个目录）之后自动生成就会生效
- 删除时一起清理：`deleteSave` 会列出 `saves/<id>/` 下所有对象逐个删除，生成物自然包含在内（已由端到端测试断言）
- 旧的"离线自包含 HTML"路径（`生成查看页.bat`）仍然可用：那种记录带 `viewer` 字段，卡片优先用它

## 阶段 D（已完成）

- **旗帜瘦身**：`assets/flags/mods/`（14,550 个文件，仅本地）留在 `.gitignore` 里；发布的是 `base/` + `modded/` + 两个 `colonial*`，共 2,125 个文件
- **`assets/`、`背景图/` 移进 `public/`**，于是 `public/` 就是整个部署产物，Pages 不需要构建步骤
- **`pnpm verify:deploy`** 闸门：文件数、单文件上限、入口文件、国旗覆盖率、背景图清单完整性
- **自定义域名**：见上面第 5 步（Dashboard 一键完成）

## 已知取舍

- 存档本体存 R2 而不是 GitHub 仓库：仓库不会被几十 MB 的存档撑大，也不受 Cloudflare 两万文件上限影响
- 删除是**真删**（R2 对象一起清），没有回收站——需要的话可以改成软删除
- 目录页没有权限体系，只有一个共享口令；个人站点够用，多用户则需换成 Cloudflare Access
