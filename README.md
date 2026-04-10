# Hermes 控制中心

一个面向终端的 Hermes 控制面板，用来集中完成 Hermes Agent 的安装、启动、更新、排障、聊天和卸载。

## 功能概览

- 一键安装 Hermes，并自动初始化和启动网关
- 启动、停止、重启 Hermes 网关
- 打开模型管理中心、初始化向导和交互式聊天
- 查看最近网关日志，做基础环境自检
- 一键写入 OpenAI 兼容模型提供商配置
- 提供官方卸载、保留数据卸载、完全卸载三种方式

## 运行环境

- Linux 或 macOS
- Bash
- `curl` 或 `wget`，用于拉取 Hermes 官方安装脚本
- `systemctl`、`journalctl`、`pgrep` 为可选依赖

> `systemctl` 和 `journalctl` 不存在时，脚本仍可运行，只是网关服务管理和日志查看能力会受限。

## 快速开始

```bash
wget -O hermes-control.sh https://raw.githubusercontent.com/Hoinor/hermes-control/main/hermes-control.sh && chmod +x hermes-control.sh && ./hermes-control.sh
```

脚本启动后会显示控制面板，可直接输入编号执行对应操作。

## 网页控制台（可视化）

项目内新增了 Web 控制台（默认端口 `15678`），支持：

- 仪表盘：系统概览、Hermes/Gateway 实时状态、快捷操作
- 服务管理：启停控制、版本检测、一键升级、Gateway 安装/卸载、配置备份与还原
- 模型配置：多服务商增删改查、模型拖拽排序、自动保存与撤销
- 模型测试：批量连通性测试与延迟检测
- 日志查看：多日志源实时查看与关键词过滤
- 聊天：流式响应与 Markdown 渲染
- 首次启动需要设置管理员密码，后续登录后可访问控制台

### 启动方式（Linux/macOS）

```bash
chmod +x run-web-console.sh
./run-web-console.sh
```

### 启动方式（Windows PowerShell）

```powershell
.\run-web-console.ps1
```

启动后访问：

```text
http://127.0.0.1:15678
```

## 菜单说明

| 编号 | 功能                                    |
| ---- | --------------------------------------- |
| `1`  | 一键安装 Hermes，并尝试初始化、启动网关 |
| `2`  | 启动网关                                |
| `3`  | 停止网关                                |
| `4`  | 重启网关                                |
| `5`  | 打开模型管理中心                        |
| `6`  | 进入初始化向导                          |
| `7`  | 启动 Hermes 对话界面                    |
| `8`  | 更新 Hermes                             |
| `9`  | 查看最近网关日志                        |
| `10` | 环境自检                                |
| `11` | 卸载 Hermes                             |
| `12` | 一键添加模型提供商                      |
| `0`  | 退出                                    |

## 一键添加模型提供商

菜单 `12` 会引导你输入以下信息：

- 模型 URL
- API Key
- 模型名

脚本会自动：

- 备份现有 `~/.hermes/config.yaml`
- 写入自定义提供商配置
- 把当前模型切换到刚输入的 OpenAI 兼容端点

适合快速接入 OpenAI、兼容 OpenAI API 的代理服务，或本地模型网关。

## 卸载说明

卸载菜单现在分成三种方式：

- 推荐卸载：调用 Hermes 官方卸载命令
- 保留数据：只删除程序代码、启动器和网关服务，保留配置与数据
- 完全卸载：删除整个 `~/.hermes` 目录及相关启动器

默认涉及的主要路径包括：

- 代码目录：`~/.hermes/hermes-agent`
- 配置文件：`~/.hermes/config.yaml`
- 密钥文件：`~/.hermes/.env`
- 数据目录：`~/.hermes/cron`、`~/.hermes/sessions`、`~/.hermes/logs`

## 项目结构

```text
.
├── web_console/
│   ├── app.py
│   ├── requirements.txt
│   ├── templates/index.html
│   └── static/
│       ├── app.css
│       └── app.js
├── run-web-console.sh
├── run-web-console.ps1
├── hermes-control.sh
└── README.md
```

## 注意事项

- 脚本以当前用户身份运行，删除操作只会处理当前用户家目录下的 Hermes 相关路径
- 如果 Hermes 官方卸载命令失败，脚本会提供手动卸载选项
