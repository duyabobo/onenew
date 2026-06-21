from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    admin_host: str = "0.0.0.0"
    admin_port: int = 9000

    # 真实 LLM provider 配置
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    llm_model: str = "gpt-4o"

    # 请求超时（秒）
    llm_timeout: int = 120

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
