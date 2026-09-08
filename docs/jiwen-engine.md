# Jiwen 持续状态引擎

Jiwen 是同一个 ChatGPT 伴侣的持续内部状态，不创建新角色或独立机器人。C Pocket 在现有进程中每 5 分钟推进一次五轴状态，并把未处理事件写入与投递渠道无关的持久队列。

## 持久化与恢复

- Railway 卷仍挂载在 `/app/data`；Jiwen 只使用 `/app/data/jiwen/state.json`。
- 状态、事件队列、幂等锁存和精简历史由同一次原子 rename 提交。
- 重启后按 `lastTick` 与当前时间的实际差值补算；上游单次 60 分钟上限由分段推进处理，只对补算后的最终状态生成事件。
- 未确认、未投递事件不会被队列修剪。历史不保存 secret 或完整聊天正文。
- Pocket、RSS、媒体和 C-Memory 的原有文件与目录不迁移、不删除。

所有默认值都在 `server/jiwen-config.js`，包括时区、tick 间隔、五轴初值、漂移率、阈值、安静信号、免打扰、主动联系限额、delta 限制以及 9 个 tone-grid 情绪簇。

初始五轴为 connection `0.08`、pride `0.22`、valence `0.18`、arousal `-0.12`、immersion `0.42`。事件阈值为 observation `0.22`、considerContact `0.42`、forceContact `0.62`、prideBlock `0.45`、valenceActivity `-0.55`、arousalAgitation `0.65`。主动联系最短间隔 120 分钟、每天最多 3 条，默认免打扰为 `00:30—09:00`（`Asia/Shanghai`）。

## MCP 工具

读取：

- `jiwen_status`
- `jiwen_guidance`
- `jiwen_pending_triggers`
- `jiwen_history`

写入：

- `jiwen_record_interaction`
- `jiwen_set_user_status`
- `jiwen_set_activity`
- `jiwen_apply_delta`
- `jiwen_ack_trigger`

没有清空全部状态的工具。`jiwen_apply_delta` 对每一轴做服务端单次幅度校验。只有 `jiwen_record_interaction(type="user_reply")` 会完全重置 connection；主动消息或成功投递 contact 只做配置中的部分缓解。

`user_reply` 不再隐式调整 pride、arousal、valence 或 immersion，四轴原始数值严格保持不变。
普通回复保留当前用户状态；明确的 `signal_text` 忙碌／睡眠信号会更新相应状态和安静期，正文不持久化。
新交互继续更新时间戳、重置连接事件锁存并追加精简历史。相同 `type + message_id` 在保留的历史范围内
去重（默认最近 500 条历史，包含其他历史类型），返回 `recorded=false`，不重复改动状态、时间戳或历史；
去重跨重启有效。未提供 `message_id` 的调用各自记录。本修复不迁移或补偿已有五轴数值。

## ChatGPT 主动联系消费者

ChatGPT 侧消费者只需执行：

1. `jiwen_pending_triggers(action="contact", limit=1)`。
2. 无事件时不生成消息、不调用 ack。
3. 有事件时调用 `jiwen_guidance(mode="proactive")`，结合当前聊天上下文自然生成一句话，不使用固定模板。
4. 消息成功产生后调用 `jiwen_ack_trigger(id=..., status="delivered", delivery_channel="chatgpt")`。

如果宿主的定时任务无法在空结果时保持安静，应暂停该任务。事件仍保留在队列中，不需要改服务端状态。

## Callhome 接口

Callhome 不需要接触状态文件：

1. 调用 `jiwen_pending_triggers(action="contact", limit=1)`。
2. 调用 `jiwen_guidance(mode="proactive")`。
3. 成功发起通话或留言。
4. 调用 `jiwen_ack_trigger(id=..., status="delivered", delivery_channel="callhome")`。

确认接口是幂等的；同一个事件重复确认不会重复降低 connection，也不会重复记为投递。

## 回滚

把 Railway 服务部署回接入前提交即可。旧版本不会读取 `/app/data/jiwen/`，Pocket、RSS、媒体和 MCP 数据继续使用原路径。不要删除 Jiwen 目录；重新部署本版本时会从原状态继续。
