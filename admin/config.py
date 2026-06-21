from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    admin_host: str = "0.0.0.0"
    admin_port: int = 9000

    # MongoDB（存储 MCP 配置 + skill 元数据）
    mongo_uri: str = "mongodb://mongo:27017"
    mongo_db: str = "pi_agent"

    # 共享文件系统根目录（global/skills/ 放在此处，与 pi-runtime 共享）
    sandbox_root: str = "/data/sandboxes"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
