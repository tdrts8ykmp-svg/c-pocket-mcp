# 在 ChatGPT Work 里玩 Detroit AI Player

这个模块将 Joey Zhang 的 [Detroit AI Player](https://github.com/Baba88611/detroit-ai-player)
接入已有的 C Pocket MCP。当前对话中的助手直接阅读场景并选择行动，默认中文，
不调用额外模型 API。它是 32 章文字分支游戏，没有官方游戏画面或本机游戏安装。

服务部署后，在 ChatGPT 的 C Pocket 插件设置中刷新工具列表，再在 Work 对话里说：

> 用 C Pocket 开始《底特律：变人》中文游戏。你来做选择，我陪你看。记住存档编号，先玩第一章。

## 工具与进度

- `detroit_start_game`：新游戏，返回不透明的 `game_id`。
- `detroit_get_scene`：读取当前场景或恢复存档。
- `detroit_choose_action`：提交显示的选项序号与最新 `turn`。
- `detroit_continue_game`：读完本章结局后进入下一章。
- `detroit_get_history`：分页恢复已发生的剧情和选择。

每次行动自动保存。必须保留 `game_id` 才能恢复该局；“继续”不要调用开始新游戏。
服务端只返回当前和过去的剧情，不返回内部数值、概率、分支条件或未触发的结局。
工具没有读取整本剧本、列出结局或跳到未来章节的入口。游玩时不得通过其他工具
查攻略或读取源仓库剧情；只依据本局已经呈现的场景行动。
跨章因果与多个主角的结局按照原始数据结算。

## 托管

沿用 C Pocket 原有 MCP 入口、访问控制、端口与持久卷。
新增数据仅写入 `<C_POCKET_DATA_DIR>/detroit/games.sqlite3` 及 SQLite 的 WAL 文件。
没有新增模型 API 密钥，没有更换原来的 Pocket/RSS/记忆数据路径。
Docker 镜像增加 Python 3；游戏桥只使用 Python 标准库，不需要 pip。
仅每次调用游戏工具时启动短命 Python 进程，不后台自动玩、不主动调用其他工具。

本地开发需要 Python 3.10+；如命令不是 `python3`，配置 `DETROIT_PYTHON_BIN` 为其路径。
游戏初始化失败不阻断 RSS/口袋服务；`/health` 的 `capabilities.detroit` 会为 false。
部署后应确认该标记为 true，并用 MCP 客户端检查五个 `detroit_*` 工具。

测试：`npm run check` 包含原有 Pocket/RSS/Jiwen 回归与游戏 MCP 集成测试。
数据与游戏引擎归属、许可证及上游修改说明见 `server/detroit/ATTRIBUTION.md`。
游戏剧情仅限非商业使用。
