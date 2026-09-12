import {readFileSync} from "node:fs"

// Generated from AGENT_PROMPT_SPEC.md §2/§4; versioned runtime copy.
export const PROMPT_VERSION = "wellio-prompt/0.1.0"
export const SYSTEM_PROMPT = readFileSync(new URL("./prompts/wellio.md", import.meta.url), "utf8")
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  "get_day_context": "每轮首先调用；写入后、上下文过期或版本冲突后重读。返回当前日期、恢复、摄入汇总、训练、条件及上下文引用。此工具读取事实，不修改用户目标或安排。",
  "get_gym_equipment": "生成指定场地训练前查询其可用器械、占用情况和负重口径。gymId 必须是受支持场地。返回没有动作目录时不能猜 catalogId；不修改器械状态。",
  "query_history": "只查询本轮相关的有限日期历史。exercise_load 必须携带同动作 exerciseId 和同器械 equipmentId；无匹配数据表示缺少依据，不能推测历史重量。不访问任意用户、日期或 SQL。",
  "search_restaurant_menu": "查询用户指定餐厅的公开菜单证据，restaurant 和 city 必填，branch 按需要提供。每轮最多一次外部尝试，失败也不换关键词重试。partial/not_found 不代表取得完整菜单，未知价格不能用于预算保证。不记餐、不下单。",
  "mutate_meal_log": "仅在本轮可信意图允许时新增、修改或删除实际摄入。add 必须有 meal；update 必须有 mealId、mealItemId、changes；delete 需 mealId，仅明确删除整餐时省略 mealItemId。比例相对原始份量，重复半份仍为0.5。营养估算使用 estimated=true，单位按schema。返回真实保存回执，成功后重读上下文；不把推荐记录为摄入。",
  "undo_meal_change": "仅撤销当前会话中用户指定的一次已保存餐食操作，operationId 取真实回执。存在后续冲突时不能强制撤销；不删除整天记录，不自动重做原操作。",
  "propose_workout": "根据有效 contextReadId 创建训练或休息顺延候选。workout scope 必须提供完整 workout；schedule 日期由服务端分配。reason 与结构化展示字段遵循双语schema。必须满足器械、时间、完成事实、负重来源及适用知识依据。成功只代表候选已保存，不代表已应用或已开始；用户须点击 Apply。",
  "record_workout_progress": "仅操作已生效训练：start_workout、complete_exercise、undo_exercise、finish_workout。动作操作需 exerciseId；结束需 actualMinutes，有未完成动作时按服务端要求取得真实确认。不代替 Apply，不把完成一组记作整个动作，不猜实际时长。"
}
