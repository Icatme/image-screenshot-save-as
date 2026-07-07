# Image & Screenshot Save As Chrome 插件设计

## 1. 目标

做一个 **纯本地执行、无远程代码、简洁易用** 的 Chrome Manifest V3 扩展，为网页图片和网页截图增加右键菜单能力，按“格式优先”组织：

- `PNG >`
  - `Save`
  - `Save & Copy Path`
- `JPG >`
  - `Save`
  - `Save & Copy Path`
- `WebP >`
  - `Save`
  - `Save & Copy Path`

核心原则：

- 所有逻辑和脚本都随扩展本地打包
- 不依赖云端接口、不上传图片、不做远程配置下发
- 交互入口只放在浏览器图片和普通页面右键菜单，避免复杂 UI
- 默认行为清晰，失败时给出明确提示

---

## 2. 产品定位

这是一个 **“右键即用”的效率型小工具**，不是图像编辑器。

用户场景：

- 浏览网页时把图片快速另存为指定格式
- 保存后顺手复制本地文件路径，便于发给同事或粘贴到工具里
- 保存后顺手复制图片本体，便于直接粘贴到聊天工具、文档或设计软件
- 保存网页可视区域截图或整页长截图

非目标：

- 不做批量下载
- 不做录屏或屏幕级截图
- 不做在线压缩或远端转码
- 不做复杂预览弹窗

---

## 3. 交互设计

## 3.1 右键菜单信息架构

建议顶层菜单名：

- `Image Save As`

图片右键时展开为：

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

普通页面右键时展开为：

```text
Page Screenshot As
├─ Visible Page
│  ├─ PNG
│  │  ├─ Save
│  │  └─ Save & Copy Path
│  ├─ JPG
│  │  ├─ Save
│  │  └─ Save & Copy Path
│  └─ WebP
│     ├─ Save
│     └─ Save & Copy Path
└─ Full Page
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

这样做的原因：

- 顶层只有一个入口，不污染原生右键菜单
- 第一层只保留 3 个格式项，扫描成本更低
- 用户先决定格式，再决定是否复制，心智更顺
- 避免依赖“父菜单既能点又能展开”的不稳定交互
- 每个实际动作都落在叶子节点，逻辑清楚，事件处理简单

## 3.2 默认行为

- 所有 `Save` / `Save & Copy *` 动作都默认弹出系统保存对话框，相当于真正的 “Save As”
- 用户确认保存位置后，扩展完成格式转换并下载到本地
- `Save`：只保存，不复制
- `Save & Copy Path`：下载完成后复制最终本地绝对路径

说明：

- 如果后续验证 Chrome 原生菜单在某些平台上支持“父项可点击且可展开”，也不建议首版采用
- 首版优先选稳定、可预期、跨平台一致的层级结构

## 3.3 反馈方式

不做复杂页面。反馈只保留两种：

- 成功：短通知，例如 `Saved as PNG and copied path`
- 失败：短通知，例如 `Copy image failed: clipboard permission denied`

可选增强：

- 在扩展图标徽标上闪一下成功状态
- 在通知中带文件名，但不展示过长路径

---

## 4. 功能设计

## 4.1 保存格式

首版支持：

- PNG
- JPG
- WebP

转换规则：

- PNG：无损，保留透明通道
- JPG：不支持透明，透明区域填充白色背景
- WebP：默认有损质量 0.92

建议默认质量配置：

- JPG: `0.92`
- WebP: `0.92`

## 4.2 文件命名

默认命名模板建议：

```text
{pageTitle}-{imageName}.{ext}
```

命名来源优先级：

1. 原图 URL 文件名
2. 页面标题
3. `image`

命名清洗规则：

- 去掉非法文件名字符
- 连续空格折叠为单个 `-`
- 超长文件名截断到安全长度

重名处理：

- 交由 Chrome 下载系统处理
- 若用户手动另存，则由系统对话框决定

## 4.3 Save & Copy Path

行为定义：

1. 执行保存
2. 监听下载完成
3. 读取最终保存路径
4. 将绝对路径写入剪贴板

复制内容示例：

```text
C:\Users\name\Downloads\cat-image.webp
```

失败策略：

- 保存成功但复制失败：提示 `Saved, but path copy failed`
- 不回滚已保存文件

## 5. 技术架构

## 5.1 Manifest V3 结构

建议文件结构：

```text
/manifest.json
/src/background/service-worker.js
/src/offscreen/offscreen.html
/src/offscreen/offscreen.js
/src/lib/image-convert.js
/src/lib/file-name.js
/src/lib/clipboard.js
/src/options/options.html
/src/options/options.js
/assets/icons/*
```

## 5.2 模块职责

### background service worker

负责：

- 注册右键菜单
- 响应菜单点击
- 拉取图片数据
- 本地转码
- 触发下载
- 跟踪下载完成状态
- 调用 offscreen 文档执行剪贴板写入
- 发通知

### offscreen document

负责：

- 执行 `navigator.clipboard.writeText`
- 执行 `navigator.clipboard.write`

这样设计的原因：

- MV3 service worker 不适合直接做剪贴板交互
- offscreen 文档是官方推荐的后台 DOM 能力承载方式

### lib/image-convert

负责：

- 把原图 Blob 解码为 `ImageBitmap`
- 用 `OffscreenCanvas` 绘制
- 按目标格式导出 Blob
- 统一透明背景、质量参数、尺寸信息

### options page

负责少量配置：

- JPG 质量
- WebP 质量
- WebP 复制失败时是否回退 PNG
- 文件名模板

首版可以没有 popup，只保留 options 页面。

---

## 6. 权限与安全设计

## 6.1 目标

尽量少权限，同时保证“任意网页图片右键即可保存”。

建议权限：

- `contextMenus`
- `downloads`
- `storage`
- `offscreen`
- `clipboardWrite`
- `scripting`
- `activeTab`

Host 权限建议：

- `http://*/*`
- `https://*/*`
- `file:///*`
- `data:*`
- `blob:*`

说明：

- `file://` 页面除 manifest 声明外，还需要用户在 Chrome 扩展详情页启用“允许访问文件网址”
- 未开启时，扩展应给出明确提示，不应静默失败

## 6.2 无远程代码约束

必须满足：

- 不加载任何远程 JS
- 不使用 CDN 脚本
- 不使用远端配置文件
- 不使用 `eval` / `new Function`
- CSP 锁死为仅扩展本地资源

可以在商店说明中明确写：

- `All image conversion happens locally on-device.`
- `No image data is uploaded to any server.`
- `No remote code.`

## 6.3 最小信任面

为了避免被 Chrome 或用户认为“高风险扩展”，设计上避免：

- 读取页面文本内容
- 注入复杂 content script
- 收集浏览历史
- 网络上报
- 账号系统

首版尽量只依赖：

- 右键选中的图片 URL
- 用户主动触发截图时临时访问当前标签页
- 下载 API
- 剪贴板 API

---

## 7. 图片处理流程

## 7.1 Save as PNG/JPG/WebP

```text
用户右键图片
→ 选择菜单项
→ background 获取 srcUrl
→ fetch 原图 Blob
→ 解码为 ImageBitmap
→ OffscreenCanvas 转为目标格式 Blob
→ chrome.downloads.download(saveAs: true)
→ 成功/失败通知
```

## 7.2 Save & Copy Path

```text
保存流程
→ 监听 downloads.onChanged
→ 获取 DownloadItem.filename
→ offscreen 写入文本剪贴板
→ 通知结果
```

## 7.3 Visible Page Screenshot

```text
用户右键页面
→ 选择 Visible Page / 格式 / 动作
→ background 调用 chrome.tabs.captureVisibleTab
→ 解码为 ImageBitmap
→ OffscreenCanvas 转为目标格式 Blob
→ chrome.downloads.download(saveAs: true)
→ 成功/失败通知
```

## 7.4 Full Page Screenshot

```text
用户右键页面
→ 选择 Full Page / 格式 / 动作
→ 注入脚本读取页面高度与滚动位置
→ 从顶部按视口高度逐屏滚动
→ 每屏调用 chrome.tabs.captureVisibleTab
→ OffscreenCanvas 纵向拼接
→ 恢复原滚动位置
→ chrome.downloads.download(saveAs: true)
→ 成功/失败通知
```

## 8. 异常与边界

需要提前处理的情况：

- 原图是 `data:` URL
- 原图是 `blob:` URL
- 原图或页面来自 `file://` 本地文件
- 原图跨域
- 图片是 SVG
- 图片加载成功但转码失败
- JPG 遇到透明图
- 页面图片懒加载，右键时 URL 已更新
- 下载取消
- 下载成功但本地路径读取失败
- 剪贴板被系统策略拦截
- 长截图期间用户切换标签页
- `file://` 本地页面未开启扩展文件网址访问
- 页面过长导致单张图片超过 Canvas 安全阈值
- 固定定位元素在滚动拼接中重复出现

设计决策：

- SVG：首版当作位图渲染后导出 PNG/JPG/WebP，不保留矢量
- 动图：首版只导出首帧静态图
- 超大图：超过安全阈值时提示失败或降级处理，避免后台内存爆掉
- 长截图：首版采用滚动拼接，不申请 `debugger` 权限

建议阈值：

- 最大边长：`16384`
- 最大像素数：`80 MP`

---

## 9. UI 取向

这个插件的设计方向是 **“极简工具化”**：

- 用户几乎感知不到界面存在
- 没有花哨弹窗
- 没有首页
- 没有仪表盘
- 只有一个可靠的右键入口和一个很轻的设置页

视觉建议：

- 图标用黑白双色，偏工具感
- 插件名直接覆盖当前功能边界，例如 `Image & Screenshot Save As`
- options 页延续系统风格，低视觉噪音

---

## 10. 首版实现范围

建议 V1 范围：

- Manifest V3
- 图片右键菜单
- 按 PNG/JPG/WebP 三种格式分组
- 每组包含 `Save` / `Save & Copy Path`
- 本地转码
- 成功/失败通知
- 最小 options 页面

暂不做：

- 批量保存
- 自定义快捷键
- 原图格式识别后智能推荐
- 文件名规则可视化编辑器
- 下载历史

---

## 11. 后续实现建议

按下面顺序推进最稳：

1. 先做菜单、下载、通知主流程
2. 再接本地转码
3. 再接 `Save & Copy Path`

这样可以先验证最关键的 “右键保存” 是否稳定，再补复制能力。

---

## 12. 建议的英文商店短描述

```text
Save any web image as PNG, JPG, or WebP. All processing runs locally. No remote code.
```

## 13. 建议的中文一句话描述

```text
为网页图片增加右键另存为 PNG/JPG/WebP，并支持保存后复制路径或复制图片，全部本地执行。
```
