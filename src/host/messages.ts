import { createSystemMessage } from '@deepseek-ai/dsh-llm'

/**
 * `createSystemMessage` 的**跨版本兼容调用**。
 *
 * 这个函数的签名在两个版本间不一样，而两份类型都得能编译通过：
 *   · **0.1.5-rc.3**（npm 上按 peer 范围 `>=0.1.5-rc <2` 解析到的就是它，CI 的构建校验用的这份）：
 *     `createSystemMessage(text, plugin)` —— 两个都必填，少传一个直接 TS2554（发布被卡过一次）；
 *   · **0.1.7-rc.x**（本机/新运行时）：`createSystemMessage(text)` —— 第二参数是历史遗留，传了会被忽略。
 *
 * 所以这里把它当"接受可选第二参数"的函数来调：两个版本都编译得过，运行时也都正确
 * （旧版正好拿到它想要的"组装这段提示词的插件名"，新版直接忽略）。
 */
export const systemMessageOf = createSystemMessage as unknown as (
  text: string,
  plugin?: string,
) => ReturnType<typeof createSystemMessage>
