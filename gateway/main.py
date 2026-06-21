import logging
import logging.config

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from routes import session, stream
from services import mongo_client, redis_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Pi Agent Gateway", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(session.router)
app.include_router(stream.router)


@app.on_event("startup")
async def on_startup() -> None:
    logger.info("Gateway 启动中...")
    await mongo_client.connect()
    await redis_client.connect()
    logger.info("Gateway 启动完成，监听 %s:%d", settings.gateway_host, settings.gateway_port)


@app.on_event("shutdown")
async def on_shutdown() -> None:
    logger.info("Gateway 关闭中...")
    await mongo_client.disconnect()
    await redis_client.disconnect()


@app.get("/health", tags=["health"])
async def health() -> dict:
    return {"status": "ok"}
