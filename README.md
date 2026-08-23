# Image & Screenshot Save As

一个 Chrome Manifest V3 扩展，为网页图片和网页截图提供 PNG、JPG、WebP 另存为能力。图片读取、转码和截图拼接均在本机浏览器内完成；扩展不上传图片，也不加载远程代码。

要求 Chrome 116 或更高版本。

## 功能

- 图片右键：`Image Save As > PNG/JPG/WebP > Save / Save & Copy Path`
- 页面右键：`Page Screenshot As > Visible Page/Select Area/Full Page > PNG/JPG/WebP > Save / Save & Copy Path`
- JPG、WebP 导出质量设置；PNG 始终无损
- 可选择每次显示系统“另存为”窗口，或静默保存到浏览器默认下载目录
- 保存完成后可复制最终本地路径
- 设置页显示最近活动，并保留本地保存历史
- 支持英文、简体中文、繁体中文、西班牙语和德语界面

点击浏览器工具栏中的扩展图标会打开设置页。设置更改会自动保存。

## 安装已发布版本

1. 打开 [GitHub Releases](https://github.com/Icatme/image-screenshot-save-as/releases/latest)，下载 `image-screenshot-save-as-chrome-<version>.zip`。
2. 将 ZIP 完整解压到一个固定目录；后续不要删除或移动该目录。
3. 在 Chrome 打开 `chrome://extensions`，开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择刚解压且包含 `manifest.json` 的目录。
5. 如需在 `file://` 页面使用，在扩展详情页额外开启“允许访问文件网址”。

Chrome 不会把普通 ZIP 直接安装为扩展，因此必须先解压再加载。

## 开发加载

本项目没有构建步骤，仓库根目录就是开发版扩展目录：

```powershell
git clone https://github.com/Icatme/image-screenshot-save-as.git
Set-Location image-screenshot-save-as
```

随后在 `chrome://extensions` 开启“开发者模式”，选择“加载已解压的扩展程序”，并选择仓库根目录。修改代码后，在扩展卡片上点击“重新加载”。

`dist/` 是发布产物，不是日常开发入口。

开发验证与发布打包使用 Node.js 22.12+ 和 PowerShell：

```powershell
npm ci
npm test
npm run test:browser
npm run package:release
npm run verify:release
```

`test:browser` 会加载系统 Chrome，验证区域选择的 Top Layer 覆盖、真实键鼠输入、截图裁剪和 WebP 透明度；`package:release` 生成确定性的解压目录与 ZIP，`verify:release` 校验源文件、解压目录和 ZIP 逐文件一致。

## 保存行为

- 默认关闭静默保存：每次动作都显示系统“另存为”窗口，由用户确认位置；取消窗口即取消本次下载，不会自动改为静默保存。
- 开启静默保存：文件直接保存到浏览器的默认 `Downloads` 目录或其子目录。
- `Save & Copy Path` 会在下载完成后复制 Chrome 返回的最终本地绝对路径；复制失败不会删除已经保存的文件。
- Chrome 下载 API 不能让扩展直接写入任意系统目录。
- 图片文件名优先使用原图 URL 文件名，其次使用页面标题，最后回退为 `image`；截图名由页面名和截图模式生成。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `contextMenus` | 添加图片和页面右键菜单 |
| `downloads` | 创建下载并在完成后读取最终文件路径 |
| `storage` | 保存设置、待处理下载状态、最近活动和保存历史 |
| `notifications` | 在保存完成、复制失败或下载中断时显示系统通知 |
| `offscreen`、`clipboardWrite` | 在 MV3 后台流程中复制最终路径，并管理临时 Blob URL |
| `scripting`、`activeTab` | 仅在用户触发时选择截图区域、读取当前页面截图尺寸、滚动页面或提取受限图片 |
| `http://*/*`、`https://*/*` | 读取用户右键选择的网络图片 |
| `file:///*` | 在用户另行开启“允许访问文件网址”后处理本地页面 |

扩展没有常驻内容脚本、账号系统、分析上报或远程配置。

## 本地数据与保留上限

- `chrome.storage.sync`：保存界面语言、JPG/WebP 质量和静默保存开关。若浏览器启用了 Chrome 同步，这些设置可能随 Chrome 账号同步；其中不含图片内容或保存历史。
- `chrome.storage.local`：最多保留 12 条最近活动和 200 条保存历史。记录包含操作结果、格式、保存路径、错误信息、截图类型及时间；不会保存图片二进制内容。保存路径属于本机敏感信息，可在设置页经确认后清空历史。
- `chrome.storage.session`：保存当前浏览器会话中的待处理下载、截图租约和捕获节流时间，用于 MV3 service worker 恢复；不是长期历史。

图片内容只在处理和下载所需的内存/临时 Blob URL 中存在，流程结束后会释放。

## 已知限制

- 某些 `blob:` 图片或保护较强的站点可能阻止读取。
- Chrome 禁止扩展在 Chrome 应用商店页面运行脚本，因此该页面不支持图片提取、区域选择和整页截图；可见区域截图仍可使用。
- 动图只导出首帧静态图；SVG 会栅格化后导出。
- 普通图片转换限制为最大边长 `16384px`、最大 `80 MP`。
- 单个压缩图片源限制为 `64 MiB`，超过上限会在解码前停止。
- 区域选择只截取当前可视窗口内拖拽的矩形，不在拖拽时自动滚动页面；按 `Esc` 或右键可取消。
- 整页截图通过滚动当前标签页逐屏拼接；滚动停滞、切换标签页或页面中断发生在至少完成一屏之后时，会裁掉未绘制尾部、以 `-partial` 文件名保存已有内容，并在历史中记录中断原因与已捕获高度。首屏失败不会创建空下载。固定元素仍可能在拼接结果中重复。
- 整页截图限制为最大边长 `32767px`、最大 `100 MP`。

## License

[MIT](./LICENSE)
