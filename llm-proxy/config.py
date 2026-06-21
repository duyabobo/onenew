from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    host: str = "0.0.0.0"
    port: int = 9001

    # 真实 LLM provider 配置（env 作为默认值，数据库配置优先）
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    llm_model: str = "gpt-4o"
    llm_timeout: int = 120

    # MongoDB（持久化 LLM 配置，hot reload 无需重启）
    mongo_uri: str = "mongodb://mongo:27017"
    mongo_db: str = "pi_agent"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
