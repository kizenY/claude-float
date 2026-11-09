# usage · 订阅用量扩展

GLM Coding Plan（智谱 bigmodel / Z.ai）各重置窗口的用量面板，浮窗与 trine 共用。

- 配置：`~/.claude-float/glm.json` → `{ "apiKey": "…", "endpoint": "https://open.bigmodel.cn" }`
  （Z.ai 用户 endpoint 换 `https://api.z.ai`）。key 只在扩展进程里用，不进任何输出。
- 缓存：`~/.claude-float/usage-cache.json`，60 秒内直接用；拉取限时 3.2 秒
  （宿主 view 超时 5 秒），失败回退上一次成功值（标注「缓存值」）。
- 窗口命名沿用老浮窗底行的约定：接口不回窗口名，按重置时间排序对号入座
  （最近的 = 5 小时窗，其次是周窗）。

安装：浮窗 `node ext.js add exts/usage`；trine `trine-agent ext add <本目录>`。
