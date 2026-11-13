"""Private, role-scoped token gateway for the initial BOOSTERA camera test."""

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import time
from collections import OrderedDict, deque
from datetime import timedelta
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from livekit import api


def access_expiry(config, role, code_hash):
    """Keep existing codes valid while allowing scoped, expiring phone links."""
    global_expiry = int(config["access_expires_at"])
    if hmac.compare_digest(code_hash, config[role + "_code_hash"]):
        return global_expiry
    if role == "publisher":
        for link in config.get("publisher_links", []):
            if hmac.compare_digest(code_hash, link["code_hash"]):
                return min(global_expiry, int(link["expires_at"]))
    return None


def create_app(config_path=None):
    path = config_path or os.environ["BOOSTERA_TRANSPORT_CONFIG"]
    config = json.loads(Path(path).read_text())
    required = ("api_key", "api_secret", "origin", "url", "room",
                "publisher_code_hash", "viewer_code_hash", "access_expires_at")
    if any(not config.get(key) for key in required):
        raise RuntimeError("Incomplete private transport configuration")
    links = config.get("publisher_links", [])
    if not isinstance(links, list) or len(links) > 16:
        raise RuntimeError("Invalid temporary publisher links")
    for link in links:
        if (not isinstance(link, dict)
                or not isinstance(link.get("code_hash"), str)
                or len(link["code_hash"]) != 64
                or any(c not in "0123456789abcdef" for c in link["code_hash"])
                or type(link.get("expires_at")) is not int):
            raise RuntimeError("Invalid temporary publisher link")
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    buckets = OrderedDict()
    lock = asyncio.Lock()

    def result(status, body):
        return JSONResponse(body, status_code=status, headers={
            "Cache-Control": "no-store", "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        })

    @app.get("/api/transport/health")
    async def health():
        return result(200, {"status": "ok", "service": "boostera-transport"})

    @app.post("/api/transport/token")
    async def token(request: Request):
        # Only this loopback service and the same-origin Caddy route are intended
        # callers. Caddy replaces X-Forwarded-For; proxy headers are disabled in
        # uvicorn so arbitrary forwarding headers never change request.client.
        if request.headers.get("origin") != config["origin"]:
            return result(403, {"error": "origin_not_allowed"})
        if request.headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
            return result(415, {"error": "json_required"})
        peer = request.client.host if request.client else "unknown"
        address = request.headers.get("x-forwarded-for", peer) if peer in {"127.0.0.1", "::1"} else peer
        now = time.monotonic()
        async with lock:
            while buckets and next(iter(buckets.values()))[-1] < now - 60:
                buckets.popitem(last=False)
            attempts = buckets.setdefault(address, deque())
            while attempts and attempts[0] < now - 60:
                attempts.popleft()
            if len(attempts) >= 20:
                return result(429, {"error": "too_many_attempts"})
            attempts.append(now)
            buckets.move_to_end(address)
            if len(buckets) > 2048:
                buckets.popitem(last=False)
        body = bytearray()
        try:
            async for part in request.stream():
                body.extend(part)
                if len(body) > 4096:
                    return result(413, {"error": "request_too_large"})
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError, RecursionError):
            return result(400, {"error": "invalid_request"})
        if not isinstance(payload, dict):
            return result(400, {"error": "invalid_request"})
        role, code = payload.get("role"), payload.get("code")
        if not isinstance(role, str) or role not in {"publisher", "viewer"} or not isinstance(code, str) or not 16 <= len(code) <= 128:
            return result(401, {"error": "invalid_access_code"})
        try:
            code_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()
        except UnicodeEncodeError:
            return result(401, {"error": "invalid_access_code"})
        expires_at = access_expiry(config, role, code_hash)
        if expires_at is None:
            return result(401, {"error": "invalid_access_code"})
        wall_time = int(time.time())
        remaining = expires_at - wall_time
        if remaining <= 0:
            return result(403, {"error": "access_expired"})
        ttl = min(900, remaining)
        publisher = role == "publisher"
        identity = "phone-camera" if publisher else "receiver-" + secrets.token_hex(8)
        grants = api.VideoGrants(
            room_join=True,
            room=config["room"],
            can_publish=publisher,
            can_subscribe=not publisher,
            can_publish_data=False,
            can_publish_sources=["camera", "microphone"] if publisher else [],
            can_update_own_metadata=False,
        )
        jwt = (api.AccessToken(config["api_key"], config["api_secret"])
               .with_identity(identity)
               .with_name("BOOSTERA camera" if publisher else "BOOSTERA receiver")
               .with_grants(grants)
               .with_ttl(timedelta(seconds=ttl))
               .to_jwt())
        return result(200, {
            "url": config["url"], "token": jwt,
            "room": config["room"], "expiresAt": wall_time + ttl,
        })

    return app
