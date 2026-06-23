import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from logger import setup_logging
from middleware import AccessLogMiddleware
from routes.config import router as config_router
from routes.skills import router as skills_router
from services import mongo_client

setup_logging("admin")
logger = logging.getLogger(__name__)

app = FastAPI(title="Pi Agent Admin", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(AccessLogMiddleware)

app.include_router(config_router)
app.include_router(skills_router)


@app.on_event("startup")
async def on_startup() -> None:
    await mongo_client.connect()
    logger.info("Admin 服务已就绪")


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await mongo_client.disconnect()


@app.get("/health", tags=["health"])
async def health() -> dict:
    return {"status": "ok"}
