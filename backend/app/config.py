from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    metabase_url: str = "https://metabase.limechat.ai"
    metabase_api_key: str = ""
    clickhouse_database_id: int = 82
    account_id: int = 28982
    cors_origins: str = "*"


settings = Settings()