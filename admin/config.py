from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    admin_host: str = "0.0.0.0"
    admin_port: int = 9000

    # 真实 LLM provider 配置（env 作为默认值，数据库配置优先）
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    llm_model: str = "gpt-4o"
    llm_timeout: int = 120

    # MongoDB（存储 LLM / MCP 配置 + skill 元数据）
    mongo_uri: str = "mongodb://mongo:27017"
    mongo_db: str = "pi_agent"

    # 共享文件系统根目录（global/skills/ 放在此处，与 pi-runtime 共享）
    sandbox_root: str = "/data/sandboxes"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
