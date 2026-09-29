# WebGL 交付 Skill v3.1.0

交付真实 GPU / shader / 3D 交互的 HTML，route=webgl-html、kind=interactive。按需求选一个适当的 WebGL 技术，不用静态图片冒充实时效果。

使用 canvas.getContext('webgl2')，能力不足时给出可读提示或可用的 webgl 回退。编译 shader 时记录编译错误，DPR 最大为 2，窗口变化时同步 canvas 分辨率和 viewport。用 requestAnimationFrame 管理动画，页面隐藏时减少计算，释放不用的 GPU 资源。文字覆盖层保持可读与键盘可达。

相机与物体必须分离：模型位于原点时，视图应移至合适距离，不能让相机落在几何体内部。根据画布宽高比调整构图，让主体完整可见并保留边距。暂停时停止无效绘制，恢复时再启动动画；页面隐藏时暂停 requestAnimationFrame，避免后台持续占用 GPU。

优先自包含单 HTML；实际需要 Worker/WASM 时声明和打包依赖。宿主能识别 WebGL/Worker/SharedArrayBuffer 并提供 powered preview，不绕过宿主沙箱。依据用户需求实现质量与性能边界，写完交付，不声称已完成额外 GPU 兼容测试。

## GPU 与交互规则

- 按效果选一种主要技术：shader 场、光线步进、实例几何或纹理后处理；预算与对象数量匹配。不要默认添加大量粒子、后处理和性能计数器。
- 检查 shader 编译与 program 链接结果，在生成的代码中给出错误提示，避免静默黑屏；处理 context lost/restored。帧时间用于动画增量并设上限，恢复页面后不出现巨大跳变。
- Pointer 事件支持拖动、取消与触控，提供必要的键盘或按钮替代；overlay 不覆盖主要视觉。尊重 reduced-motion，保留可操作的静止状态。
- 优先内联 shader、样式和小纹理；大型素材合理缩减分辨率，不让循环内重复分配 GPU 缓冲或材质。暂停/卸载清理监听器、帧循环和 GPU 资源。
- 不透明场景使用 alpha:false；覆盖层文字按场景最亮区域安排底色或对比度。遵循已有设计体系的品牌色，不让标题或说明遮住主要效果；旧示例的颜色、标题长度和“总能60fps”不是所有任务的硬约束或性能承诺。
