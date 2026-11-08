#!/usr/bin/env python3
"""
Mock EdgeOne Hub Server (Role: hub, Port: 19001)
Simulates EdgeOne Makers Hub for llmproxy2 testing:
- Validates Authorization: Bearer <NODE_TOKEN>
- Serves POST /api/node/config (Lazy-Once, ETag 304, 401 revocation)
- Accurately counts /api/node/config requests to verify zero billing leakage / singleflight
"""
import hashlib
import json
import os
import time
from typing import Optional
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse, Response

app = FastAPI(title="Mock EdgeOne Hub Server")

VALID_NODE_TOKEN = os.environ.get("MOCK_NODE_TOKEN", "stk_node_bench_test_token_123")
UPSTREAM_URL = os.environ.get("UPSTREAM_URL", "http://127.0.0.1:19002/v1")

# State
_state = {
    "config_calls": 0,
    "revoked": False,
    "config_version": 1,
    "etag": "etag-v1-initial-hash",
    "call_history": []
}


from datetime import datetime, timezone, timedelta

def _generate_payload(version: int = 1):
    return {
        "_version": version,
        "providers": {
            "chaos_prov": {
                "id": "chaos_prov",
                "name": "Chaos Provider",
                "base_url": UPSTREAM_URL,
                "enabled": True,
                "origin": "vault",
                "api_keys": [
                    {"id": "k1", "label": "k1", "key": "sk-key-1", "enabled": True, "origin": "vault"},
                    {"id": "k2", "label": "k2", "key": "sk-key-2", "enabled": True, "origin": "vault"}
                ]
            }
        },
        "agent_models": {
            "bench-model": {
                "enabled": True,
                "routing_strategy": "sticky_failover",
                "candidates": [
                    {"provider": "chaos_prov", "key_label": "k1", "enabled": True},
                    {"provider": "chaos_prov", "key_label": "k2", "enabled": True}
                ]
            }
        },
        "settings": {
            "run_mode": "agent",
            "agent_routing_strategy": "sticky_failover",
            "upstream_timeout_sec": 30,
            "cooldown_rate_limit_sec": 1,
            "cooldown_server_error_sec": 1,
            "cooldown_network_error_sec": 1
        }
    }


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "role": "mock-hub"}


@app.get("/metrics")
async def get_metrics():
    return {
        "ok": True,
        "config_calls": _state["config_calls"],
        "revoked": _state["revoked"],
        "config_version": _state["config_version"],
        "etag": _state["etag"],
        "history_count": len(_state["call_history"])
    }


@app.post("/admin/reset")
async def admin_reset():
    _state["config_calls"] = 0
    _state["revoked"] = False
    _state["config_version"] = 1
    _state["etag"] = "etag-v1-initial-hash"
    _state["call_history"].clear()
    return {"ok": True, "message": "State reset"}


@app.post("/admin/revoke")
async def admin_revoke():
    _state["revoked"] = True
    return {"ok": True, "revoked": True}


@app.post("/admin/unrevoke")
async def admin_unrevoke():
    _state["revoked"] = False
    return {"ok": True, "revoked": False}


@app.post("/admin/bump_config")
async def admin_bump():
    _state["config_version"] += 1
    _state["etag"] = f"etag-v{_state['config_version']}-{int(time.time())}"
    return {"ok": True, "config_version": _state["config_version"], "etag": _state["etag"]}


@app.post("/api/node/config")
async def node_config(
    request: Request,
    authorization: Optional[str] = Header(None),
    if_none_match: Optional[str] = Header(None)
):
    # 1. Node Token Authentication
    if not authorization or not authorization.startswith("Bearer "):
        return JSONResponse(status_code=401, content={"ok": False, "error": "missing_or_invalid_authorization"})

    token = authorization.split("Bearer ", 1)[1].strip()
    if token != VALID_NODE_TOKEN:
        return JSONResponse(status_code=401, content={"ok": False, "error": "invalid_node_token"})

    # 2. Revocation Check
    if _state["revoked"]:
        return JSONResponse(status_code=401, content={"ok": False, "error": "node_revoked_or_invalid"})

    # Record call
    _state["config_calls"] += 1
    _state["call_history"].append({
        "timestamp": time.time(),
        "if_none_match": if_none_match,
        "version": _state["config_version"]
    })

    current_etag = _state["etag"]
    lease_ttl = 86400  # 24 hours
    grace_ttl = 3600   # 1 hour
    now = int(time.time())
    lease_until = now + lease_ttl
    grace_until = now + grace_ttl

    headers = {
        "ETag": f'"{current_etag}"',
        "X-Config-Version": str(_state["config_version"]),
        "X-Lease-Until": str(lease_until),
        "X-Grace-Until": str(grace_until),
    }

    # 3. ETag 304 Check (zero payload renewal)
    clean_if_none = (if_none_match or "").strip().strip('"')
    if clean_if_none == current_etag:
        return Response(status_code=304, headers=headers)

    # 4. 200 OK Initial Pull or Config Updated
    body = _generate_payload(_state["config_version"])
    return JSONResponse(status_code=200, content=body, headers=headers)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("HUB_PORT", "19001"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
