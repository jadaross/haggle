from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    anthropic_api_key: str
    database_url: str
    haggle_secret_key: str

    # Server-side hard cap regardless of user config
    hard_daily_cap: int = 50

    claude_model: str = "claude-sonnet-4-6"
    log_level: str = "INFO"

    # Minimum gap between sends (seconds) even if multiple events fire at once
    min_inter_message_gap_seconds: int = 180  # 3 minutes


settings = Settings()
