# People Dream Demo

一个最小可跑的本地 demo。现在服务端已经切到 Go + SQLite，可以直接打包成单个二进制运行：

- 浏览器插件负责采集页面
- `localhost` 服务负责黑名单、去重、版本化
- 数据落到本地 SQLite，不再是 JSON 文件
- 本地面板展示“梦报”和持续关注页面
- 静态页面嵌入 Go 二进制，无需 Node 运行时

## 目录

- [main.go](/Users/karlchen/Desktop/work/people_dream/main.go)
- [store.go](/Users/karlchen/Desktop/work/people_dream/store.go)
- [report.go](/Users/karlchen/Desktop/work/people_dream/report.go)
- [extension/manifest.json](/Users/karlchen/Desktop/work/people_dream/extension/manifest.json)

## 构建

```bash
go build -o people-dream .
```

## 启动

```bash
./people-dream
```

也可以指定端口或数据目录：

```bash
./people-dream -addr 127.0.0.1:4017 -data-dir ./data
```

默认数据库文件会写到：

```text
./data/people-dream.db
```

启动后打开：

```text
http://127.0.0.1:4017
```

## 安装插件

1. 打开 Chrome 的 `chrome://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择当前项目下的 `extension` 目录

## Demo 行为

1. 页面停留 8 秒左右后，插件会自动采集当前页
2. 插件会把标题、URL、正文摘要、停留时间、滚动深度发到 `localhost`
3. 服务会先做黑名单判断
4. 对同一 URL 会记录多次访问和多次版本快照
5. 面板会生成一份简单梦报，显示主题、持续关注页面和下一步建议

## 现在已经有的能力

- 域名 / URL 黑名单
- 页面特征级敏感页拦截
- 采集暂停开关
- URL 规范化
- 访问记录
- 内容版本变化
- 本地 SQLite 存储
- 本地梦报

## 还没做的事

- 真正的 LLM 梦境推演
- 更细的站点级 URL 归一化规则
- 更强的主题聚类
- 用户登录与跨设备同步
