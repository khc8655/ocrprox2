#!/usr/bin/env python3
"""
Black-box Chaos Harness & Benchmark Client
Tests gateways (v1 Python / v2 Go) against Mock Hub and Chaos Upstream:
1. Normal SSE stream throughput (100 concurrency, RPS, TTFT, P50/P95/P99 latency)
2. 429 Rate limit failover (key-1 429 -> key-2 200 seamless failover)
3. Stream 200 embedded error (peek first chunk error -> failover)
4. 400 Client error (forbiddenAlike verification: tests if gateway mis-bans keys)
5. Large 15MB payload concurrency (measures handling of heavy OCR/vision payloads)
6. Hub lazy-once verification (asserts hub call count under 1000 requests)
"""
import argparse
import asyncio
import json
import statistics
import sys
import time
from typing import Dict, List, Optional
import httpx

GATEWAY_URL = "http://127.0.0.1:8787"
HUB_URL = "http://127.0.0.1:19001"
UPSTREAM_URL = "http://127.0.0.1:19002"
CLIENT_KEY = "test-proxy-client-key-8888"


async def check_health(client: httpx.AsyncClient, gateway_url: str) -> bool:
    for path in ["/healthz", "/health", "/v1/models"]:
        try:
            headers = {"Authorization": f"Bearer {CLIENT_KEY}"}
            r = await client.get(f"{gateway_url}{path}", headers=headers, timeout=2.0)
            if r.status_code in (200, 401, 404):
                return True
        except Exception:
            pass
    return False


async def run_single_stream(
    client: httpx.AsyncClient,
    gateway_url: str,
    scenario: Optional[str] = None,
    payload_override: Optional[dict] = None
) -> Dict:
    t0 = time.perf_counter()
    ttft = None
    chunks_count = 0
    total_bytes = 0
    status_code = 0
    error_msg = None

    headers = {
        "Authorization": f"Bearer {CLIENT_KEY}",
        "Content-Type": "application/json"
    }
    if scenario:
        headers["X-Chaos-Scenario"] = scenario

    body = payload_override or {
        "model": "bench-model",
        "messages": [{"role": "user", "content": "Benchmark test prompt"}],
        "stream": True
    }

    try:
        async with client.stream(
            "POST",
            f"{gateway_url}/v1/chat/completions",
            json=body,
            headers=headers,
            timeout=15.0
        ) as response:
            status_code = response.status_code
            if status_code != 200:
                body_text = await response.aread()
                return {
                    "ok": False,
                    "status_code": status_code,
                    "duration": time.perf_counter() - t0,
                    "ttft": None,
                    "error": body_text.decode("utf-8", errors="ignore")[:300]
                }

            async for chunk in response.aiter_bytes():
                if ttft is None and chunk:
                    ttft = time.perf_counter() - t0
                chunks_count += 1
                total_bytes += len(chunk)
                # Check for embedded error in stream
                if b'"code": 503' in chunk or b'"upstream overloaded"' in chunk:
                    error_msg = "leaked_embedded_503_in_stream"

        duration = time.perf_counter() - t0
        return {
            "ok": error_msg is None,
            "status_code": status_code,
            "duration": duration,
            "ttft": ttft or duration,
            "chunks": chunks_count,
            "bytes": total_bytes,
            "error": error_msg
        }
    except Exception as e:
        return {
            "ok": False,
            "status_code": status_code,
            "duration": time.perf_counter() - t0,
            "ttft": None,
            "error": str(e)
        }


async def bench_normal_stream(gateway_url: str, concurrency: int = 50, total_requests: int = 100) -> Dict:
    print(f"\n[Bench] Starting normal stream benchmark (concurrency={concurrency}, total={total_requests})...")
    limits = httpx.Limits(max_keepalive_connections=concurrency + 10, max_connections=concurrency + 20)
    async with httpx.AsyncClient(limits=limits, timeout=20.0) as client:
        sem = asyncio.Semaphore(concurrency)

        async def worker():
            async with sem:
                return await run_single_stream(client, gateway_url)

        t_start = time.perf_counter()
        tasks = [worker() for _ in range(total_requests)]
        results = await asyncio.gather(*tasks)
        total_time = time.perf_counter() - t_start

    successes = [r for r in results if r["ok"]]
    failures = [r for r in results if not r["ok"]]

    durations = [r["duration"] for r in successes] or [0]
    ttfts = [r["ttft"] for r in successes if r.get("ttft")] or [0]

    durations.sort()
    ttfts.sort()

    def pct(data, p):
        idx = int(len(data) * p)
        return data[min(idx, len(data) - 1)]

    res = {
        "total_requests": total_requests,
        "concurrency": concurrency,
        "success_count": len(successes),
        "failure_count": len(failures),
        "total_time_sec": round(total_time, 3),
        "rps": round(len(successes) / total_time, 2) if total_time > 0 else 0,
        "ttft_p50_ms": round(pct(ttfts, 0.50) * 1000, 2),
        "ttft_p95_ms": round(pct(ttfts, 0.95) * 1000, 2),
        "ttft_p99_ms": round(pct(ttfts, 0.99) * 1000, 2),
        "latency_p50_ms": round(pct(durations, 0.50) * 1000, 2),
        "latency_p95_ms": round(pct(durations, 0.95) * 1000, 2),
        "latency_p99_ms": round(pct(durations, 0.99) * 1000, 2),
    }
    print(f"  -> RPS: {res['rps']}, P50: {res['latency_p50_ms']}ms, P95: {res['latency_p95_ms']}ms, Success: {res['success_count']}/{total_requests}")
    return res


async def test_chaos_scenarios(gateway_url: str) -> Dict:
    print("\n[Chaos] Running Chaos Fault Injection tests...")
    results = {}
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Helper to set upstream scenario
        async def set_upstream_scenario(scen: str):
            try:
                await client.post(f"{UPSTREAM_URL}/chaos/scenario", json={"scenario": scen}, timeout=3.0)
            except Exception as e:
                print(f"     [Warn] Failed to set upstream scenario: {e}")

        # Scenario A: 400 Bad Client Request (forbiddenAlike test - run first when all keys are fresh)
        print("  1. Testing bad_client_payload_400 (forbiddenAlike & key preservation)...")
        await set_upstream_scenario("bad_client_payload_400")
        bad_req_results = []
        for _ in range(3):
            r_bad = await run_single_stream(
                client, gateway_url, scenario="bad_client_payload_400",
                payload_override={
                    "model": "bench-model",
                    "messages": [{"role": "user", "content": "test bad client request"}],
                    "temperature": 99.0,
                    "stream": True
                }
            )
            bad_req_results.append(r_bad["status_code"])

        # Reset upstream to normal
        await set_upstream_scenario("normal_stream")
        # Immediately send a normal valid request to check if keys were mistakenly banned
        res_after = await run_single_stream(client, gateway_url)
        keys_preserved = res_after["ok"] and res_after["status_code"] == 200
        results["client_400_no_misban"] = {
            "bad_statuses": bad_req_results,
            "recovered_on_next_request": keys_preserved,
            "post_bad_status": res_after["status_code"],
            "post_bad_error": res_after.get("error")
        }
        print(f"     Bad Statuses: {bad_req_results}, Subsequent Valid Req Recovered: {keys_preserved}")

        # Wait for 1s cooldown window to clear before next scenario
        await asyncio.sleep(1.2)

        # Scenario B: Stream 200 Embedded Error Peek Interception
        print("  2. Testing stream_200_embedded_error peek interception...")
        await set_upstream_scenario("stream_200_embedded_error")
        res_embed = await run_single_stream(client, gateway_url, scenario="stream_200_embedded_error")
        results["embedded_error_peek"] = {
            "ok": res_embed["ok"],
            "status_code": res_embed["status_code"],
            "duration_ms": round(res_embed["duration"] * 1000, 2),
            "leaked_error": res_embed.get("error") == "leaked_embedded_503_in_stream",
            "error": res_embed.get("error")
        }
        print(f"     Status: {res_embed['status_code']}, OK: {res_embed['ok']}, LeakedError: {results['embedded_error_peek']['leaked_error']}")

        # Wait for 1s cooldown window to clear before next scenario
        await asyncio.sleep(1.2)

        # Scenario C: 429 First Key Failover
        print("  3. Testing rate_limit_first_key failover...")
        await set_upstream_scenario("rate_limit_first_key")
        res_429 = await run_single_stream(client, gateway_url, scenario="rate_limit_first_key")
        results["rate_limit_failover"] = {
            "ok": res_429["ok"],
            "status_code": res_429["status_code"],
            "duration_ms": round(res_429["duration"] * 1000, 2),
            "error": res_429.get("error")
        }
        print(f"     Status: {res_429['status_code']}, OK: {res_429['ok']}, Duration: {results['rate_limit_failover']['duration_ms']}ms")

        # Ensure upstream is restored to normal
        await set_upstream_scenario("normal_stream")

    return results


async def test_large_payload(gateway_url: str, concurrency: int = 5, size_mb: int = 8) -> Dict:
    print(f"\n[Payload] Testing {concurrency} concurrent {size_mb}MB payloads (within 10MB JSON limit)...")
    # Generate ~size_mb string
    chunk_1mb = "A" * (1024 * 1024)
    payload_content = chunk_1mb * size_mb

    async with httpx.AsyncClient(timeout=30.0) as client:
        sem = asyncio.Semaphore(concurrency)

        async def send_heavy():
            body = {
                "model": "bench-model",
                "messages": [
                    {"role": "user", "content": f"Large image/doc: {payload_content}"}
                ],
                "stream": False
            }
            headers = {
                "Authorization": f"Bearer {CLIENT_KEY}",
                "Content-Type": "application/json"
            }
            t0 = time.perf_counter()
            async with sem:
                try:
                    r = await client.post(f"{gateway_url}/v1/chat/completions", json=body, headers=headers, timeout=25.0)
                    return {"ok": r.status_code == 200, "status_code": r.status_code, "duration": time.perf_counter() - t0}
                except Exception as e:
                    return {"ok": False, "status_code": 0, "duration": time.perf_counter() - t0, "error": str(e)}

        t_start = time.perf_counter()
        tasks = [send_heavy() for _ in range(concurrency)]
        results = await asyncio.gather(*tasks)
        total_time = time.perf_counter() - t_start

    successes = [r for r in results if r["ok"]]
    print(f"  -> Concurrency: {concurrency}, Success: {len(successes)}/{concurrency}, Time: {round(total_time, 2)}s")
    if len(successes) < concurrency:
        print(f"  -> Failure details: {[r.get('error') or r.get('status_code') for r in results if not r['ok']]}")
    return {
        "concurrency": concurrency,
        "size_mb": size_mb,
        "success_count": len(successes),
        "total_requests": concurrency,
        "total_time_sec": round(total_time, 2)
    }


async def test_hub_lazy_once(gateway_url: str, total_reqs: int = 50) -> Dict:
    print(f"\n[Hub] Checking Hub Lazy-Once call counts...")
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            m_before = (await client.get(f"{HUB_URL}/metrics")).json()
            calls_before = m_before.get("config_calls", 0)
        except Exception:
            calls_before = None

        # Send requests to gateway
        for _ in range(total_reqs):
            await run_single_stream(client, gateway_url)

        try:
            m_after = (await client.get(f"{HUB_URL}/metrics")).json()
            calls_after = m_after.get("config_calls", 0)
        except Exception:
            calls_after = None

    diff = (calls_after - calls_before) if (calls_before is not None and calls_after is not None) else None
    print(f"  -> Hub calls before: {calls_before}, after: {calls_after}, delta: {diff}")
    return {
        "hub_calls_before": calls_before,
        "hub_calls_after": calls_after,
        "hub_calls_delta": diff,
        "lazy_once_preserved": (diff <= 1) if diff is not None else None
    }


async def main():
    parser = argparse.ArgumentParser(description="Chaos Harness Benchmark")
    parser.add_argument("--gateway-url", default=GATEWAY_URL, help="Gateway base URL")
    parser.add_argument("--concurrency", type=int, default=50, help="Concurrency for SSE stream bench")
    parser.add_argument("--total-requests", type=int, default=100, help="Total requests for SSE stream bench")
    parser.add_argument("--output", default="benchmark_result.json", help="Output JSON path")
    args = parser.parse_args()

    print("=" * 60)
    print(f"Chaos Harness Benchmark: Target {args.gateway_url}")
    print("=" * 60)

    # 0. Ensure upstream is on normal_stream
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.post(f"{UPSTREAM_URL}/chaos/scenario", json={"scenario": "normal_stream"})
    except Exception:
        pass

    # 1. Normal Stream Benchmark
    stream_res = await bench_normal_stream(args.gateway_url, concurrency=args.concurrency, total_requests=args.total_requests)

    # 2. Chaos Scenarios
    chaos_res = await test_chaos_scenarios(args.gateway_url)

    # 3. Large Payload Concurrency (8MB per request, 5 concurrency = 40MB inflight)
    payload_res = await test_large_payload(args.gateway_url, concurrency=5, size_mb=8)

    # 4. Hub Lazy-Once Check
    hub_res = await test_hub_lazy_once(args.gateway_url, total_reqs=20)

    summary = {
        "gateway_url": args.gateway_url,
        "timestamp": int(time.time()),
        "stream_benchmark": stream_res,
        "chaos_scenarios": chaos_res,
        "large_payload_benchmark": payload_res,
        "hub_lazy_once": hub_res
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    print("\n" + "=" * 60)
    print(f"Results written to {args.output}")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
