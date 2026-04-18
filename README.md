# People Dream Workspace

一个使用 `pnpm workspace` 管理的 monorepo，拆成两个独立项目：

- `apps/backend`：本地 Node.js + TypeScript 服务，负责 SQLite 存储、页面面板、梦报生成与 Codex 集成
- `apps/extension`：浏览器插件，继续保持静态目录直出，可直接作为未打包扩展加载

## 目录

- `apps/backend`
- `apps/extension`

## 环境要求

- Node.js 18+
- `pnpm` 10+

## 安装依赖

```bash
pnpm install
```

## 常用命令

在仓库根目录运行：

```bash
pnpm dev:backend
pnpm build
pnpm check
pnpm pack:extension
```

也可以只跑单个项目：

```bash
pnpm --filter backend dev -- --addr 0.0.0.0:9095 --data-dir ./data
pnpm --filter backend build
pnpm --filter backend start -- --addr 0.0.0.0:9095 --data-dir ./data
pnpm --filter extension check
pnpm --filter extension pack
```

## 后端

后端代码位于 `apps/backend`，默认数据库路径仍然由 `--data-dir` 控制。

开发模式：

```bash
pnpm --filter backend dev -- --addr 0.0.0.0:9095 --data-dir ./data
```

生产启动：

```bash
pnpm --filter backend start -- --addr 0.0.0.0:9095 --data-dir ./data
```

默认数据库文件会写到：

```text
apps/backend/data/people-dream.db
```

服务启动后打开：

```text
http://127.0.0.1:9095
```

## 插件

插件位于 `apps/extension`，当前仍是无需打包的静态目录。安装方式：

1. 打开 Chrome 的 `chrome://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择当前项目下的 `apps/extension` 目录

插件继续通过 popup 中的服务地址配置连接本地后端，默认地址为：

```text
http://127.0.0.1:9095
```

`pnpm --filter extension pack` 会把当前插件静态文件复制到 `apps/extension/dist`，方便后续做发布包。

## 当前能力

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
