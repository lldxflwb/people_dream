# People Dream Demo

一个最小可跑的本地 demo。后端现在迁到 Node.js + TypeScript，继续使用本地 SQLite：

- 浏览器插件负责采集页面
- 本地 TS 服务负责黑名单、去重、版本化
- 数据落到本地 SQLite
- 本地面板展示“梦报”和持续关注页面
- 后端为后续接入 Codex SDK 预留了 TS 结构

Codex SDK 官方文档：

- https://developers.openai.com/codex/sdk

官方文档当前写明：

- TypeScript 包名是 `@openai/codex-sdk`
- 需要 Node.js 18 或更高版本

## 目录

- [src/server.ts](/Users/karlchen/Desktop/work/people_dream/src/server.ts)
- [src/store.ts](/Users/karlchen/Desktop/work/people_dream/src/store.ts)
- [src/report.ts](/Users/karlchen/Desktop/work/people_dream/src/report.ts)
- [src/codex.ts](/Users/karlchen/Desktop/work/people_dream/src/codex.ts)
- [extension/manifest.json](/Users/karlchen/Desktop/work/people_dream/extension/manifest.json)

## 安装

```bash
npm install
```

## 检查

```bash
npm run check
```

这里会执行：

- `tsc --noEmit`
- `eslint`

并额外约束禁止显式 `any`。

## 构建

```bash
npm run build
```

## 启动

```bash
npm run start -- --addr 0.0.0.0:9095 --data-dir ./data
```

开发模式：

```bash
npm run dev -- --addr 0.0.0.0:9095 --data-dir ./data
```

默认数据库文件会写到：

```text
./data/people-dream.db
```

启动后打开：

```text
http://127.0.0.1:9095
```

## 安装插件

1. 打开 Chrome 的 `chrome://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择当前项目下的 `extension` 目录

## Demo 行为

1. 页面停留 8 秒左右后，插件会自动采集当前页
2. 插件会把标题、URL、正文摘要、停留时间、滚动深度发到本地服务
3. 服务会先做黑名单判断
4. 对同一 URL 会记录多次访问和多次版本快照
5. 面板可以按天翻页查看收集记录
6. 插件 popup 可以查看当前页面是否已经被采集
7. 面板支持删除单条收集页面记录
8. 面板会生成一份简单梦报，显示主题、持续关注页面和下一步建议
9. 面板会创建 AI 梦报任务并轮询任务状态，完成后展示并缓存结果

## 现在已经有的能力

- 域名 / URL 黑名单
- 页面特征级敏感页拦截
- 采集暂停开关
- URL 规范化
- 访问记录
- 内容版本变化
- 按天分页查看采集信息
- 插件自定义服务地址
- 当前页面采集状态查看
- 删除单条收集页面记录
- 本地 SQLite 存储
- 本地梦报
- 基于本地 Codex 登录态的 AI 梦境推理任务与缓存

## 还没做的事

- 夜间自动触发的梦境推演任务
- 更细的站点级 URL 归一化规则
- 更强的主题聚类
- 用户登录与跨设备同步
