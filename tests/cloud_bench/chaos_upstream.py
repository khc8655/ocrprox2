#!/usr/bin/env python3
"""
Chaos Mock Upstream LLM Server (Port: 19002)
Simulates upstream providers with deterministic chaos fault injection:
1. normal_stream: Standard OpenAI/Anthropic SSE stream
2. rate_limit_first_key: key-1 -> 429, key-2 -> 200 (failover speed)
3. stream_200_embedded_error: key-1 -> 200 + stream error, key-2 -> 200 (peek interception)
4. bad_client_payload_400: all keys -> 400 identical error (tests forbiddenAlike / no mis-ban)
5. large_ocr_20mb: 10MB~20MB payload handling (tests memory ballooning & OOM resilience)
"""
import asyncio
import json
import os
import time
from typing import Optional
from fastapi import FastAPI, Header, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="Chaos Mock Upstream LLM Server")

# Global state
_state = {
    "current_scenario": "normal_stream",
    "requests_count": 0,
    "scenario_counts": {
        "normal_stream": 0,
        "rate_limit_first_key": 0,
        "stream_200_embedded_error": 0,
        "bad_client_payload_400": 0,
        "large_ocr_20mb": 0,
    },
    "keys_seen": {},  # key -> count
    "key_errors": {}, # key -> error_count
    "last_request": {}
}


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "role": "chaos-upstream"}


@app.get("/chaos/stats")
async def get_stats():
    return {
        "ok": True,
        "current_scenario": _state["current_scenario"],
        "requests_count": _state["requests_count"],
        "scenario_counts": _state["scenario_counts"],
        "keys_seen": _state["keys_seen"],
        "key_errors": _state["key_errors"]
    }


@app.post("/chaos/reset")
async def reset_stats():
    _state["requests_count"] = 0
    for k in _state["scenario_counts"]:
        _state["scenario_counts"][k] = 0
    _state["keys_seen"].clear()
    _state["key_errors"].clear()
    _state["last_request"].clear()
    return {"ok": True, "message": "Stats reset"}


@app.post("/chaos/scenario")
async def set_scenario(request: Request):
    body = await request.json()
    scenario = body.get("scenario")
    if scenario not in _state["scenario_counts"]:
        return JSONResponse(status_code=400, content={"error": f"Unknown scenario: {scenario}"})
    _state["current_scenario"] = scenario
    return {"ok": True, "current_scenario": scenario}


def _extract_key(authorization: Optional[str]) -> str:
    if not authorization:
        return "no-auth"
    parts = authorization.split()
    return parts[-1] if len(parts) > 1 else authorization


def _sse_chunk(chunk_id: str, model: str, content: str, is_final: bool = False, finish_reason: Optional[str] = None):
    data = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"content": content} if content else {},
                "finish_reason": finish_reason if is_final else None
            }
        ]
    }
    return f"data: {json.dumps(data)}\n\n".encode("utf-8")


@app.get("/v1/models")
@app.get("/models")
@app.get("/v1/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {"id": "bench-model", "object": "model", "owned_by": "chaos-upstream"},
            {"id": "bench-ocr", "object": "model", "owned_by": "chaos-upstream"}
        ]
    }


@app.post("/v1/ocr")
@app.post("/ocr")
@app.post("/v1/v1/ocr")
async def handle_ocr(request: Request, authorization: Optional[str] = Header(None)):
    key = _extract_key(authorization)
    _state["requests_count"] += 1
    _state["keys_seen"][key] = _state["keys_seen"].get(key, 0) + 1
    _state["scenario_counts"]["large_ocr_20mb"] += 1

    # Read body stream or buffered
    body_bytes = await request.body()
    size_mb = len(body_bytes) / (1024 * 1024)
    return JSONResponse(
        status_code=200,
        content={
            "ok": True,
            "received_bytes": len(body_bytes),
            "size_mb": round(size_mb, 2),
            "ocr_text": f"Mock OCR processed {round(size_mb, 2)} MB successfully with key {key}"
        }
    )


@app.post("/v1/chat/completions")
@app.post("/chat/completions")
@app.post("/v1/v1/chat/completions")
@app.post("/v1/messages")
@app.post("/messages")
@app.post("/v1/v1/messages")
async def handle_chat(
    request: Request,
    authorization: Optional[str] = Header(None),
    x_chaos_scenario: Optional[str] = Header(None)
):
    key = _extract_key(authorization)
    _state["requests_count"] += 1
    _state["keys_seen"][key] = _state["keys_seen"].get(key, 0) + 1

    scenario = x_chaos_scenario or _state["current_scenario"]
    if scenario in _state["scenario_counts"]:
        _state["scenario_counts"][scenario] += 1

    body_bytes = await request.body()
    try:
        body = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
    except Exception:
        body = {}

    model = body.get("model", "bench-model")
    stream = body.get("stream", False)

    # -------------------------------------------------------------
    # Scenario 4: bad_client_payload_400 (All keys return same 400)
    # -------------------------------------------------------------
    if scenario == "bad_client_payload_400":
        _state["key_errors"][key] = _state["key_errors"].get(key, 0) + 1
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "message": "invalid temperature: must be between 0.0 and 2.0",
                    "type": "invalid_request_error",
                    "param": "temperature",
                    "code": "invalid_parameter"
                }
            }
        )

    # -------------------------------------------------------------
    # Scenario 2: rate_limit_first_key
    # key-1 -> 429, key-2 -> 200
    # -------------------------------------------------------------
    if scenario == "rate_limit_first_key":
        if "k1" in key or "key-1" in key:
            _state["key_errors"][key] = _state["key_errors"].get(key, 0) + 1
            return JSONResponse(
                status_code=429,
                headers={"Retry-After": "2"},
                content={
                    "error": {
                        "message": "Rate limit exceeded: quota depleted for key-1",
                        "type": "rate_limit_error",
                        "code": 429
                    }
                }
            )
        # key-2 or other keys proceed to 200 stream

    # -------------------------------------------------------------
    # Scenario 3: stream_200_embedded_error
    # key-1 -> 200 headers, but first SSE packet contains error!
    # key-2 -> 200 normal stream
    # -------------------------------------------------------------
    if scenario == "stream_200_embedded_error":
        if "k1" in key or "key-1" in key:
            _state["key_errors"][key] = _state["key_errors"].get(key, 0) + 1
            async def embedded_error_generator():
                # First packet: 503 embedded error
                err_data = {
                    "error": {
                        "message": "upstream engine overloaded during stream initialization",
                        "code": 503,
                        "type": "server_error"
                    }
                }
                yield f"data: {json.dumps(err_data)}\n\n".encode("utf-8")
                yield b"data: [DONE]\n\n"
            return StreamingResponse(embedded_error_generator(), media_type="text/event-stream")
        # key-2 proceeds to normal stream

    # -------------------------------------------------------------
    # Scenario 5: large_ocr_20mb (or large chat payload)
    # -------------------------------------------------------------
    if scenario == "large_ocr_20mb" or len(body_bytes) > 2 * 1024 * 1024:
        size_mb = len(body_bytes) / (1024 * 1024)
        if stream:
            async def large_stream_gen():
                cid = f"chatcmpl-large-{int(time.time())}"
                yield _sse_chunk(cid, model, f"Echoed large payload of {round(size_mb, 2)} MB successfully.")
                yield _sse_chunk(cid, model, "", is_final=True, finish_reason="stop")
                yield b"data: [DONE]\n\n"
            return StreamingResponse(large_stream_gen(), media_type="text/event-stream")
        else:
            return JSONResponse(
                status_code=200,
                content={
                    "id": f"chatcmpl-large-{int(time.time())}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": f"Echoed large payload of {round(size_mb, 2)} MB successfully with key {key}."
                            },
                            "finish_reason": "stop"
                        }
                    ],
                    "usage": {"prompt_tokens": int(size_mb * 250000), "completion_tokens": 15, "total_tokens": int(size_mb * 250000) + 15}
                }
            )

    # -------------------------------------------------------------
    # Scenario 1: normal_stream (default standard stream)
    # -------------------------------------------------------------
    if stream:
        async def normal_stream_generator():
            cid = f"chatcmpl-bench-{int(time.time()*1000)}"
            # Fast burst of tokens
            tokens = ["Hello", " from", " Cloud", " Chaos", " Lab!", " Token-1", " Token-2", " [Done]"]
            for tok in tokens:
                yield _sse_chunk(cid, model, tok)
                await asyncio.sleep(0.005)  # 5ms jitter
            yield _sse_chunk(cid, model, "", is_final=True, finish_reason="stop")
            yield b"data: [DONE]\n\n"

        return StreamingResponse(
            normal_stream_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
        )
    else:
        # Non-streaming response
        return JSONResponse(
            status_code=200,
            content={
                "id": f"chatcmpl-bench-{int(time.time()*1000)}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Hello from Cloud Chaos Lab non-streaming!"},
                        "finish_reason": "stop"
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18}
            }
        )


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("CHAOS_PORT", "19002"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
