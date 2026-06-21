from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gateway_host: str = "0.0.0.0"
    gateway_port: int = 8000

    mongo_uri: str = "mongodb://mongo:27017"
    mongo_db: str = "pi_agent"

    redis_url: str = "redis://redis:6379"

    # SSE 拉取 Redis Stream 时的阻塞超时（毫秒），用于心跳保活
    sse_block_ms: int = 5000

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
