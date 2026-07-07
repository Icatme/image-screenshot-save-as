# Image & Screenshot Save As

一个纯本地执行的 Chrome Manifest V3 扩展，为网页图片和网页截图增加右键保存能力：

- `Image Save As > PNG/JPG/WebP > Save`
- `Image Save As > PNG/JPG/WebP > Save && Copy Path`
- `Page Screenshot As > Visible Page/Full Page > PNG/JPG/WebP > Save`
- `Page Screenshot As > Visible Page/Full Page > PNG/JPG/WebP > Save && Copy Path`

## 特性

- 本地转码，不依赖任何远程服务
- 支持导出为 PNG / JPG / WebP
- 支持保存后复制本地文件路径
- 支持静默保存开关
- 支持本地保存历史记录
- 支持网页可视区域截图和整页长截图

## 开发说明

这是无构建工具版本，直接加载目录即可。

## 加载方式

1. 打开 Chrome，进入 `chrome://extensions`
2. 开启“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 选择当前目录 `V:\projects\img-save-as`
5. 如果要在 `file://` 本地 HTML 页面中使用，打开扩展详情页并启用“允许访问文件网址”

## 首版限制

- 优先保证常规 `http/https/data:` 图片稳定
- 某些 `blob:` 图片或站点保护较强的图片可能无法读取
- `file://` 本地页面需要在 Chrome 扩展详情页手动开启“允许访问文件网址”
- 动图当前只导出首帧静态图
- 超大图会因为内存保护被拒绝转换
- 长截图通过滚动当前标签页逐屏拼接，截图期间切换标签页会中止
- 超长页面会因为单张图片尺寸保护被拒绝导出

## 当前保存行为

- 默认关闭静默保存；开启后会直接保存，不弹出另存为窗口
- `Save && Copy Path` 当前会复制保存后的本地绝对路径
- Chrome 扩展下载 API 只能写到默认 `Downloads` 目录或其子目录，不能直接指定任意系统“图片”库路径
- 历史记录当前保存在 `chrome.storage.local`，不需要 sqlite

## License

MIT
