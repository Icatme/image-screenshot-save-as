# Image & Screenshot Save As：当前实现设计

本文描述仓库当前实现，不是未来功能提案。产品边界是：由用户通过右键菜单主动触发，在浏览器本机完成图片读取、截图、转码、下载和可选的路径复制。

## 1. 产品边界

已实现：

- 网页图片导出为 PNG、JPG 或 WebP
- 当前可视区域截图和整页滚动截图
- 每种输出均支持 `Save` 和 `Save & Copy Path`
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
└─ Full Page
   └─ PNG / JPG / WebP
      └─ Save / Save & Copy Path
```

菜单随界面语言生成。点击工具栏扩展图标会打开设置页；扩展没有 popup。

## 3. 保存契约

- `silentSave=false` 是默认值。下载使用 `saveAs: true`，必须由用户在系统窗口中确认；用户取消后，本次下载结束，不会自动切换为静默保存。
- `silentSave=true` 时下载使用 `saveAs: false`，保存到 Chrome 默认下载目录。
- `Save` 只保存文件。
- `Save & Copy Path` 等待下载完成，从 `DownloadItem.filename` 取得最终绝对路径，再通过 offscreen 文档写入文本剪贴板。
- 文件已经保存但路径复制失败时，保留文件并记录/显示复制错误，不回滚下载。
- 已创建的下载若被取消或中断，会记录为 `interrupted`，并释放对应的临时 Blob URL；用户在系统窗口取消、Chrome 未返回 download ID 时只产生失败反馈，不伪造下载记录。

## 4. 运行时模块

### `src/background/service-worker.js`

负责：

- 初始化和重建本地化右键菜单
- 解析图片/截图菜单命令
- 获取图片数据，协调可视区域或整页截图
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
- 截图名由页面标题/URL 名称加 `visible-screenshot` 或 `full-page-screenshot` 后缀组成
- 清理 Windows 非法字符和保留名，压缩空白，限制最终长度

### `src/lib/clipboard.js` 与 `src/offscreen/*`

MV3 service worker 没有可直接使用的 DOM 剪贴板和 Blob URL 生命周期，因此该模块按需创建 offscreen 文档，负责：

- 创建和撤销下载所需的 Blob URL
- 将最终文件路径写入文本剪贴板
- 仅在没有活跃操作和 Blob URL 时关闭文档，避免并发下载提前失效

### `src/lib/capture-state.js`、`src/lib/screenshot-page.js` 与 `src/lib/storage-state.js`

- `capture-state` 串行管理截图租约和跨 worker 的捕获速率时间戳
- `screenshot-page` 保存、修改并恢复页面滚动状态；页面属性和超时恢复作为 worker 中断后的第二道保护
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

### 整页

1. 读取页面尺寸、原滚动位置和主要滚动容器。
2. 从顶部逐屏滚动，按 Chrome `captureVisibleTab` 速率约束串行捕获。
3. 只拼接每次新出现的区域，生成完整画布。
4. 在成功、失败或 worker 恢复路径中恢复页面滚动状态。
5. 按目标格式导出并进入统一下载流程。

整页结果最大边长为 `32767px`、最大像素数为 `100,000,000`。扩展一次只执行一个截图任务；捕获期间标签页失焦或切换会中止流程。

## 7. 状态、反馈与恢复

- 待处理下载保存在 `chrome.storage.session`，而不是只放在 service worker 全局变量中，避免 MV3 worker 休眠后完全失去完成回调上下文。
- 下载状态以 download ID 为独立记录更新，避免并发下载互相覆盖。
- 保存历史和最近活动由后台串行更新；历史清空也通过后台消息进入同一写入序列，避免与完成回调竞争。
- 截图租约和最近一次捕获时间保存在会话存储中，worker 重启后仍可恢复页面并继续遵守 `captureVisibleTab` 速率限制。
- 工具栏徽标短暂显示 `OK` 或 `ERR`；标题包含最近一次结果，同时创建系统通知。
- 设置页读取 `recentActivity`，让用户能查看成功和失败详情。

## 8. 数据与保留策略

| 存储区 | 内容 | 上限/生命周期 |
| --- | --- | --- |
| `chrome.storage.sync` | 语言、JPG/WebP 质量、静默保存 | 由 Chrome 设置同步策略管理 |
| `chrome.storage.local` / `recentActivity` | 标题、消息、状态、时间 | 最近 12 条 |
| `chrome.storage.local` / `saveHistory` | 动作、格式、结果、路径、错误、截图类型和时间 | 最近 200 条 |
| `chrome.storage.session` | 每个下载的临时处理上下文、截图恢复状态 | 当前浏览器会话 |

不持久化图片二进制内容。保存历史包含本机文件路径，因此设置页提供经确认的清空入口。历史不保存无展示用途的原图 URL 或页面标题。

## 9. 权限与安全边界

- `contextMenus`：创建用户主动触发的图片和页面菜单
- `downloads`：创建下载并取得最终路径
- `storage`：设置、活动、历史和会话恢复
- `notifications`：显示保存、复制和下载结果
- `offscreen`、`clipboardWrite`：Blob URL 和路径复制
- `scripting`、`activeTab`：仅在触发动作时读取/滚动当前页面
- `http://*/*`、`https://*/*`、`file:///*`：读取选中图片；文件协议仍由 Chrome 的用户开关控制

安全约束：

- 不加载远程 JavaScript、CDN 或远程配置
- 不使用 `eval` / `new Function`
- 不上传图片，不收集浏览历史，不做网络上报
- 不安装常驻 content script；页面脚本只在用户操作关联的当前标签页临时执行

## 10. 已知边界

- 动图只导出首帧；SVG 栅格化后输出
- 某些站点策略可能阻止 `blob:` 或受保护图片读取
- Chrome 应用商店禁止扩展脚本注入；后台直读失败时不再尝试注入，并对图片提取和整页截图返回稳定的本地化错误
- Chrome 下载 API 只能写入默认下载目录及其子目录，不能直接写入任意系统图库目录
- 整页截图依赖页面滚动和逐屏拼接，固定定位元素可能重复；页面在捕获期间发生布局变化也会影响结果
- 超过画布安全阈值的输入直接失败，不自动降采样
