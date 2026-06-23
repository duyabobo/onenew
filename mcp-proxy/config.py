from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    mcp_proxy_port: int = 8080
    mongo_uri: str = "mongodb://mongo:27017"
    mongo_db: str = "pi_agent"
    # 工具列表缓存刷新间隔（秒），对应环境变量 TOOL_REFRESH_INTERVAL_MS（毫秒）
    tool_refresh_interval_ms: int = 60_000

    @property
    def tool_refresh_interval_s(self) -> float:
        return self.tool_refresh_interval_ms / 1000.0

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
