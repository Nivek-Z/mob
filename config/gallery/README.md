# 共用图床分类

categories.json 统一管理分类 ID和显示名称。article-images 用于编辑器自动插图，gallery 用于其他上传；可改显示名称但保持这两个默认 ID。分类被项目使用时不可移除。媒体字节在 R2，展示元数据在 content/gallery/。遵守 ../../docs/PLATFORM.md。

R2 里的图片只有登记进 content/gallery/items.json 后才属于图床；公开图库还要求同时 isPublic/isListed。后台“R2 中未登记的素材”可以发现主题种子与旧对象，支持私有预览与纳入。主题/旧对象创建可管理副本并保留原链接；规范历史上传保留原 ID；全部纳入默认私有。扫描 GET 不写配置，失败重试不删除已完成字节。
