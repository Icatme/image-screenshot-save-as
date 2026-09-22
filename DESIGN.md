# Image & Screenshot Save As：当前实现设计

本文描述仓库当前实现，不是未来功能提案。产品边界是：由用户通过右键菜单主动触发，在浏览器本机完成图片读取、截图、转码、下载和可选的路径复制。

## 1. 产品边界

已实现：

- 网页图片导出为 PNG、JPG 或 WebP
- 当前可视区域截图和整页滚动截图
- 图片和单张截图支持 `Save` 和 `Save & Copy Path`；分页截图支持 `Save`
- 整页截图支持单张、最长分页和 A4 比例分页；超限时由用户确认输出方式
- JPG、WebP 质量配置，界面语言配置和静默保存配置
- 最近活动、保存历史和下载结果反馈

不在当前范围内：

- 批量下载、图像编辑、录屏或系统级截图
- 复制图片本体
- 用户自定义文件名模板
- 在线转码、账号系统、遥测和远程配置

## 2. 用户入口与菜单

图片右键菜单：

```text
Image Save As
├─ PNG
│  ├─ Save
│  └─ Save & Copy Path
├─ JPG
│  ├─ Save
│  └─ Save & Copy Path
└─ WebP
   ├─ Save
   └─ Save & Copy Path
```

页面右键菜单：

```text
Page Screenshot As
├─ Visible Page
│  └─ PNG / JPG / WebP
│     └─ Save / Save & Copy Path
├─ Select Area
│  └─ PNG / JPG / WebP
│     └─ Save / Save & Copy Path
└─ Full Page
   └─ PNG / JPG / WebP
      └─ Save / Save & Copy Path
```

菜单随界面语言生成。能保存单张时直接进入原保存流程；超限时在独立选项页选择最长分页、A4 分页或取消，不在菜单重复列出这些选项，也不预选分页方式。点击工具栏扩展图标会打开设置页；扩展没有 popup。

## 3. 保存契约

- `silentSave=false` 是默认值。下载使用 `saveAs: true`，必须由用户在系统窗口中确认；用户取消后，本次下载结束，不会自动切换为静默保存。
- `silentSave=true` 时下载使用 `saveAs: false`，保存到 Chrome 默认下载目录。
- `Save` 只保存文件。
- `Save & Copy Path` 等待下载完成，从 `DownloadItem.filename` 取得最终绝对路径，再通过 offscreen 文档写入文本剪贴板。
- 分页输出使用经用户授权的 File System Access 文件夹句柄，首次选择后在 IndexedDB 中记住；不把 Chrome 下载返回的路径字符串当成目录写权限。每次分页仍需明确确认方式与目录，无超限自动分页或缩小。文件夹接口没有绝对路径，分页选项页明确提示仅保存图片、不复制路径，历史仅显示文件夹名与文件名。
- 文件已经保存但路径复制失败时，保留文件并记录/显示复制错误，不回滚下载。
- 已创建的下载若被取消或中断，会记录为 `interrupted`，并释放对应的临时 Blob URL；用户在系统窗口取消、Chrome 未返回 download ID 时只产生失败反馈，不伪造下载记录。

## 4. 运行时模块

### `src/background/service-worker.js`

负责：

- 初始化和重建本地化右键菜单
- 解析图片/截图菜单命令
- 获取图片数据，协调可视区域、区域选择或整页截图
- 调用图片转换、命名、下载和剪贴板模块
- 跟踪下载完成/中断状态
- 写入最近活动和保存历史
- 更新扩展图标的 `OK` / `ERR` 徽标、标题反馈和系统通知

### `src/lib/image-convert.js`

使用 `createImageBitmap` 和 `OffscreenCanvas` 在本地解码、绘制并导出：

- PNG 无损并保留透明通道
- WebP 使用配置质量并保留透明通道
- JPG 使用配置质量，透明区域先填充白色
- 压缩源文件上限 `64 MiB`，在解码前拒绝超限输入
- 普通图片最大边长 `16384px`，最大像素数 `80,000,000`

### `src/lib/image-encoding.js` 与 `src/lib/image-source.js`

- `image-encoding` 统一格式、MIME、质量、Canvas alpha 和 JPG 白底策略，并提供稳定错误码
- `image-source` 负责带凭据的受限图片读取、25 秒完整响应超时、64 MiB 流式上限、页面内回退提取和文件网址权限校验
- 文件网址权限无法由 Chrome 明确确认时按拒绝处理，不猜测为已授权

### `src/lib/file-name.js`

- 图片名依次取原图 URL 文件名、页面标题、`image`
- 截图名由页面标题/URL 名称加 `visible-screenshot`、`selected-area-screenshot` 或 `full-page-screenshot` 后缀组成；部分长截图再追加 `partial`
- 清理 Windows 非法字符和保留名，压缩空白，限制最终长度

### `src/lib/clipboard.js` 与 `src/offscreen/*`

MV3 service worker 没有可直接使用的 DOM 剪贴板和 Blob URL 生命周期，因此该模块按需创建 offscreen 文档，负责：

- 创建和撤销下载所需的 Blob URL
- 将最终文件路径写入文本剪贴板
- 仅在没有活跃操作和 Blob URL 时关闭文档，避免并发下载提前失效

### `src/lib/capture-state.js`、`src/lib/screenshot-page.js`、`src/lib/screenshot-region.js` 与 `src/lib/storage-state.js`

- `capture-state` 串行管理截图租约和跨 worker 的捕获速率时间戳
- `screenshot-page` 保存、修改并恢复页面滚动状态；页面属性和超时恢复作为 worker 中断后的第二道保护
- `screenshot-region` 在 Top Layer 的 `<dialog>` 内使用隔离 Shadow DOM 接收矩形选择，并按实际捕获位图尺寸换算裁剪坐标
- `storage-state` 用每个 download ID 的独立会话键保存待处理状态，并串行、去重写入活动与历史

### `src/lib/settings.js` 与 `src/lib/i18n.js`

- 设置通过 `chrome.storage.sync` 保存并在读写时归一化
- 默认质量均为 `0.92`，质量被限制在 `0.10` 到 `1.00`
- 默认语言跟随 Chrome，也可手动选择 `en`、`zh_CN`、`zh_TW`、`es`、`de`

### `src/options/*`

- 设置修改自动保存；初始化或持久化失败会在页面内显示，而不是只产生未处理的 Promise
- 提供最近活动、带确认的历史清空和语义化历史对话框
- 窄屏优先显示设置，营销介绍折叠到页面末尾

## 5. 图片保存流程

```text
用户右键图片并选择格式/动作
→ service worker 取得 srcUrl、页面信息和设置
→ 读取图片 Blob
→ image-convert 本地转码
→ offscreen 创建临时 Blob URL
→ chrome.downloads.download
→ 将待处理记录写入 storage.session
→ downloads.onChanged 报告完成或中断
→ 释放临时 Blob URL
→ 可选复制最终路径
→ 写入活动/历史并显示结果反馈
```

HTTP/HTTPS 图片由扩展后台读取。`data:`、`blob:`、`file:` 或后台读取失败的图片会在用户触发范围内通过页面脚本提取；`file:` 还要求用户在 Chrome 扩展详情页开启文件网址访问。

## 6. 截图流程

### 可视区域

1. 校验当前标签页和文件网址访问权限。
2. 调用 `chrome.tabs.captureVisibleTab`。
3. 将捕获结果按目标格式转码，然后进入统一下载流程。

### 选择区域

1. 在当前页面临时注入隔离的区域选择覆盖层，阻止选择期间的页面滚动和指针事件。
2. 用户拖拽矩形后移除覆盖层；`Esc`、右键、切换标签页或超时会取消，不创建下载。
3. 调用 `chrome.tabs.captureVisibleTab`，按实际位图与 CSS 视口的比例换算坐标并裁剪。
4. 按目标格式导出裁剪结果，然后进入统一下载流程。

### 整页

1. 读取页面尺寸、原滚动位置和主要滚动容器。
2. 临时禁用实际滚动目标的 CSS scroll snap，从顶部逐屏滚动，并按 Chrome `captureVisibleTab` 速率约束串行捕获。
3. 单张超限时，先恢复页面，再打开扩展确认页。页面显示两种分页预计张数；用户选择分页方式、授权目录并确认后，后台重新激活原标签页，以原 document ID 绑定捕获，防止截取导航后的其他页面。
4. `screenshot-capture` 统一普通页面和主要滚动容器的帧裁剪；使用共享物理像素原点处理非整数缩放。`screenshot-pagination` 只绘制连续的新像素行，跨页时拆分当前帧；每页编码后释放画布，等待目录写入完成再开始下一页。单张模式复用同一帧管线。
5. 捕获中断时保留已完成页面，并裁短未完成的最长分页末页（A4 末页补白）；末页文件名加 `-partial`，历史记录原因和已捕获高度。恰在分页边界中断不生成空文件，最后一条历史标明任务未完整完成。编码、目录写入错误直接停止并上报，不作为捕获中断重试保存。
6. 在成功、部分完成、失败或 worker 恢复路径中恢复页面滚动状态。
7. 单张进入原有下载流程；分页由 `screenshot-directory` 在选定目录串行写入，编号从 `001` 开始；基名含完整随机 UUID，避免不同批次争用可预测名称。写前检查目标不存在，获取句柄后检查文件为空，打开写流后及提交前再次核对大小和修改时间；检测到冲突立即中止该批次。File System Access 没有原子排他创建/提交接口，不能保证与任意外部程序互斥。

单张及每页最大边长为 `32767px`、最大像素数为 `100,000,000`；WebP 边长限制为 `16383px`。最长分页页高由边长和面积限制共同决定；A4 页高为 `round(width × 297 / 210)`，保持原始宽度，末页补白，不缩放或自动重排网页内容。扩展一次只执行一个截图任务；切换标签页会停止继续捕获并保留已有内容。分页已写入文件在 worker 或浏览器中断后仍存在，但不自动恢复后续页面。

## 7. 状态、反馈与恢复

- 待处理下载保存在 `chrome.storage.session`，而不是只放在 service worker 全局变量中，避免 MV3 worker 休眠后完全失去完成回调上下文；单条损坏记录会被隔离，不阻塞其他下载恢复。
- 下载状态以 download ID 为独立记录更新，避免并发下载互相覆盖。
- 下载完成后的 Blob URL 清理先切换为持久化的 cleanup-only 状态；失败时由后续 worker 唤醒继续重试。Blob 所属的 offscreen 文档会定期向 worker 请求回收授权，只有匹配记录已进入 cleanup-only 才撤销 URL 并回报结果；活动下载会保留并延后检查，全程不依赖可能随 MV3 worker 终止而丢失的定时器。
- 保存历史和最近活动由后台串行更新；完整与部分截图状态随待处理下载保留，历史清空也通过后台消息进入同一写入序列，避免与完成回调竞争。
- 截图租约和最近一次捕获时间保存在会话存储中，worker 重启后仍可恢复页面并继续遵守 `captureVisibleTab` 速率限制。
- 页面恢复定时器使用可续期的失联期限；每次滚动捕获更新期限，定时器只检查剩余时间，不自行续期。持续捕获可以超过 5 分钟，失联后仍恢复原滚动位置和样式；旧捕获定时器不能影响新捕获。
- 分页每次写入前持久化目标文件名，写入完成后持久化已确认张数与最后一条历史，再更新历史列表。worker 重启将遗留的 `capturing` 转为 `interrupted`，补齐历史及去重的中断反馈，不自动续写；未确认的末次写入单独提示用户检查。确认页通过后台状态请求等待恢复，并显示中断结果。
- 设置保存按编辑版本排队并在输入时捕获快照；旧保存完成不会回填新输入，也不能取消较新的防抖任务。恢复默认值同样遵守编辑版本。
- 工具栏徽标短暂显示 `OK`、`PART` 或 `ERR`；标题包含最近一次结果，同时创建系统通知。
- 设置页读取 `recentActivity`，以成功、警告、失败三种状态展示最近结果；部分截图历史同时显示原因和高度进度。

## 8. 数据与保留策略

| 存储区 | 内容 | 上限/生命周期 |
| --- | --- | --- |
| `chrome.storage.sync` | 语言、JPG/WebP 质量、静默保存 | 由 Chrome 设置同步策略管理 |
| `chrome.storage.local` / `recentActivity` | 标题、消息、状态、时间 | 最近 12 条 |
| `chrome.storage.local` / `saveHistory` | 动作、格式、结果、路径、错误、截图类型、部分原因/高度和时间 | 最近 200 条 |
| `chrome.storage.session` | 每个下载的临时处理上下文、截图恢复状态 | 当前浏览器会话 |
| IndexedDB / `screenshot-save-directory` | 最近一次分页目标文件夹句柄 | 下次选择时替换；不存图片 |

不持久化图片二进制内容。保存历史包含本机文件路径，因此设置页提供经确认的清空入口。历史不保存无展示用途的原图 URL 或页面标题。

## 9. 权限与安全边界

- `contextMenus`：创建用户主动触发的图片和页面菜单
- `downloads`：创建下载并取得最终路径
- `storage`：设置、活动、历史和会话恢复
- `notifications`：显示保存、复制和下载结果
- `offscreen`、`clipboardWrite`：Blob URL 和路径复制
- `scripting`、`activeTab`：仅在触发动作时选择区域或读取/滚动当前页面
- `http://*/*`、`https://*/*`、`file:///*`：读取选中图片；文件协议仍由 Chrome 的用户开关控制

安全约束：

- 不加载远程 JavaScript、CDN 或远程配置
- 不使用 `eval` / `new Function`
- 不上传图片，不收集浏览历史，不做网络上报
- 不安装常驻 content script；页面脚本只在用户操作关联的当前标签页临时执行

## 10. 已知边界

- 动图只导出首帧；SVG 栅格化后输出
- 某些站点策略可能阻止 `blob:` 或受保护图片读取
- Chrome 应用商店禁止扩展脚本注入；后台直读失败时不再尝试注入，并对图片提取、区域选择和整页截图返回稳定的本地化错误
- Chrome 下载 API 只能写入默认下载目录及其子目录，不能直接写入任意系统图库目录
- 区域选择限定在当前可视窗口，不提供跨滚动区域拖拽或自动滚动
- 整页截图依赖页面滚动和逐屏拼接，固定定位元素可能重复；页面在捕获期间发生布局变化也会影响结果
- 超过画布安全阈值的输入直接失败，不自动降采样
