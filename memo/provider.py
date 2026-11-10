import os


def model_provider() -> dict[str, str]:
    if os.getenv("MEMO_MODEL_PROVIDER") == "deepseek":
        return {"name": "DeepSeek", "keyName": "DEEPSEEK_API_KEY", "defaultModel": "deepseek-flash"}
    return {"name": "Anthropic", "keyName": "ANTHROPIC_API_KEY", "defaultModel": "sonnet"}


def provider_environment(model: str) -> dict[str, str]:
    provider = model_provider()
    key_name = provider["keyName"]
    key = os.getenv(key_name, "").strip()
    if not key:
        raise RuntimeError(f"请在项目 .env 中设置 {key_name}，然后重启服务。")
    if provider["name"] == "Anthropic":
        return {"ANTHROPIC_API_KEY": key, "ANTHROPIC_AUTH_TOKEN": "", "ANTHROPIC_BASE_URL": "https://api.anthropic.com"}

    default_model = provider["defaultModel"]
    return {
        "ANTHROPIC_API_KEY": "",
        "ANTHROPIC_AUTH_TOKEN": key,
        "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": default_model,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": default_model,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": default_model,
        "ANTHROPIC_MODEL": model,
        "CLAUDE_CODE_SUBAGENT_MODEL": default_model,
    }
