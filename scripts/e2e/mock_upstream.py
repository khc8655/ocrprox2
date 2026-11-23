#!/usr/bin/env python3
"""
mock_upstream.py — 双协议 mock 上游，跑在测试 VM 上。

  POST /openai/v1/chat/completions   OpenAI Chat Completions（JSON 或 SSE）
  POST /anthropic/v1/messages        Anthropic Messages（JSON 或 SSE）
  POST /fail/v1/chat/completions     恒 500（故障转移用）
  GET  /v1/models                    固定列表
  GET  /__stats                      账本：每条真实请求的路径/协议/模型/Key
  POST /__reset                      清零账本

每个请求都记一笔，所以"路由到哪家、走了哪个端点、有没有先 500 再兜底"
可以用上游账本核对，而不是只信网关自己的日志。
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RECORD = []
LOCK = threading.Lock()


def summarize():
    by_protocol, by_key, by_path, by_model = {}, {}, {}, {}
    for r in RECORD:
        by_protocol[r["protocol"]] = by_protocol.get(r["protocol"], 0) + 1
        by_path[r["path"]] = by_path.get(r["path"], 0) + 1
        by_model[r.get("model", "")] = by_model.get(r.get("model", ""), 0) + 1
        k = r.get("key") or "(none)"
        by_key[k] = by_key.get(k, 0) + 1
    return {
        "total": len(RECORD),
        "byProtocol": by_protocol,
        "byKey": by_key,
        "byPath": by_path,
        "byModel": by_model,
        "last": RECORD[-8:],
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse(self, events):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for e in events:
            self.wfile.write(e.encode())
            self.wfile.flush()
        self.close_connection = True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except Exception:
            return {"_raw": raw.decode("utf-8", "replace")}

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/__stats":
            with LOCK:
                self._send(200, summarize())
            return
        if p.endswith("/v1/models"):
            self._send(200, {"object": "list", "data": [
                {"id": "gpt-test", "object": "model"},
                {"id": "claude-test", "object": "model"},
            ]})
            return
        self._send(404, {"error": {"message": "not found", "type": "not_found"}})

    def do_POST(self):
        p = self.path.split("?")[0]
        if p == "/__reset":
            with LOCK:
                RECORD.clear()
            self._send(200, {"ok": True, "reset": True})
            return

        b = self._body()
        model = b.get("model", "")
        auth = self.headers.get("Authorization") or self.headers.get("x-api-key") or ""
        entry = {
            "path": p,
            "protocol": "anthropic" if p.startswith("/anthropic/") else ("fail" if p.startswith("/fail/") else "openai"),
            "model": model,
            "key": str(auth).replace("Bearer ", ""),
            "stream": bool(b.get("stream")),
            "messages": len(b.get("messages") or []),
            "hasSystem": any((m or {}).get("role") == "system" for m in (b.get("messages") or [])),
            "bodyKeys": sorted(b.keys()),
            "sysField": "system" in b,
            "at": int(time.time() * 1000),
        }
        with LOCK:
            RECORD.append(entry)

        if entry["protocol"] == "fail":
            self._send(500, {"error": {"message": "mock upstream exploded", "type": "server_error"}})
            return

        if entry["protocol"] == "anthropic":
            if b.get("stream"):
                self._sse([
                    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","model":"%s","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n' % model,
                    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
                    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello from mock"}}\n\n',
                    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
                    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
                    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
                ])
                return
            self._send(200, {
                "id": "msg_mock", "type": "message", "role": "assistant", "model": model,
                "content": [{"type": "text", "text": "hello from mock"}],
                "stop_reason": "end_turn", "usage": {"input_tokens": 3, "output_tokens": 4},
            })
            return

        if b.get("stream"):
            self._sse([
                'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1,"model":"%s","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n' % model,
                'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1,"model":"%s","choices":[{"index":0,"delta":{"content":" from mock"},"finish_reason":null}]}\n\n' % model,
                'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1,"model":"%s","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' % model,
                'data: [DONE]\n\n',
            ])
            return
        self._send(200, {
            "id": "chatcmpl-mock", "object": "chat.completion", "created": 1, "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "hello from mock"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7},
        })


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 19090
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    srv.daemon_threads = True
    print("mock upstream on :%d" % port, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
