const isDeepSeek = () => process.env.MEMO_MODEL_PROVIDER === "deepseek"

export function modelProvider() {
  return isDeepSeek()
    ? { name: "DeepSeek", keyName: "DEEPSEEK_API_KEY", defaultModel: "deepseek-flash" }
    : { name: "Anthropic", keyName: "ANTHROPIC_API_KEY", defaultModel: "sonnet" }
}

export function providerEnvironment(model: string): NodeJS.ProcessEnv {
  const { keyName, defaultModel } = modelProvider()
  const key = process.env[keyName]?.trim()
  if (!key) throw new Error("请在项目 .env 中设置 " + keyName + "，然后重启服务。")
  if (!isDeepSeek()) return { ANTHROPIC_API_KEY: key }
  return {
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_DEFAULT_OPUS_MODEL: defaultModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: defaultModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: defaultModel,
    ANTHROPIC_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: defaultModel
  }
}
