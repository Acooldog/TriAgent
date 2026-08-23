# Unlock Music 许可证核对记录

- 来源：GitCode 镜像 `gitcode.com/gh_mirrors/un/unlock-music`，固定核对提交为 `57f59543db33fa35efd368e2f86ca33c87b40203`。
- 许可证：上游 `LICENSE` 为 MIT License，版权归属为 MengYX（2019-2023）。
- 使用边界：酷狗 KGM 主解密逻辑只存在于私有 Provider；公开 Agent 不包含算法、适配器、资源或调用细节。
- 当前实现：私有 Provider 采用上游 KGM 字节解密算法作为第一优先路径；仅在格式不支持、能力不可用或明确可恢复错误时才允许切换私有备用能力。
- 再分发要求：正式发布前仍需随私有 Provider 保留 MIT 版权和许可文本，并人工复核依赖、NOTICE 与具体适配代码的来源记录。
