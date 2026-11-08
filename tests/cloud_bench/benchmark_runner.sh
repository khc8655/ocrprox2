#!/usr/bin/env bash
set -e

BASE_DIR="/data/home/bench"
V1_DIR="${BASE_DIR}/v1-python"
LOGS_DIR="${BASE_DIR}/logs"
RESULTS_DIR="${BASE_DIR}/results"
V1_CFG_DIR="${BASE_DIR}/v1-config"

mkdir -p "${LOGS_DIR}" "${RESULTS_DIR}" "${V1_CFG_DIR}"

PYTHON_BIN="${V1_DIR}/.venv/bin/python3"
if [ ! -f "${PYTHON_BIN}" ]; then
    PYTHON_BIN="python3"
fi

kill_port() {
    local port=$1
    echo "[Cleanup] Freeing port ${port}..."
    fuser -k "${port}/tcp" 2>/dev/null || true
    sleep 1
}

wait_url() {
    local url=$1
    local name=$2
    local retries=15
    while [ $retries -gt 0 ]; do
        if curl -s -f -m 2 "${url}" >/dev/null 2>&1; then
            echo "[Ready] ${name} is UP at ${url}"
            return 0
        fi
        sleep 1
        retries=$((retries - 1))
    done
    echo "[Error] ${name} failed to become ready at ${url}"
    return 1
}

# Sample memory function
sample_memory() {
    local target_pid=$1
    local sample_log=$2
    rm -f "${sample_log}"
    while kill -0 "${target_pid}" 2>/dev/null; do
        if [ -f "/proc/${target_pid}/status" ]; then
            local rss=$(grep -i VmRSS "/proc/${target_pid}/status" 2>/dev/null | awk '{print $2}')
            local hwm=$(grep -i VmHWM "/proc/${target_pid}/status" 2>/dev/null | awk '{print $2}')
            local fds=$(ls -1 "/proc/${target_pid}/fd" 2>/dev/null | wc -l)
            echo "$(date +%s.%N) ${rss:-0} ${hwm:-0} ${fds:-0}" >> "${sample_log}"
        fi
        sleep 0.1
    done
}

TARGET_MODE="${1:-all}"
echo "[Benchmark Target] Selected mode: ${TARGET_MODE}"

# -----------------------------------------------------------------------------
# 1. Start Mock Hub and Chaos Upstream
# -----------------------------------------------------------------------------
kill_port 19001
kill_port 19002
kill_port 8787

echo "[1/4] Starting Mock EdgeOne Hub on :19001..."
nohup ${PYTHON_BIN} ${BASE_DIR}/mock_hub.py > "${LOGS_DIR}/mock_hub.log" 2>&1 &
wait_url "http://127.0.0.1:19001/healthz" "Mock Hub"

echo "[2/4] Starting Chaos Mock Upstream LLM on :19002..."
nohup ${PYTHON_BIN} ${BASE_DIR}/chaos_upstream.py > "${LOGS_DIR}/chaos_upstream.log" 2>&1 &
wait_url "http://127.0.0.1:19002/healthz" "Chaos Upstream"

if [ "${TARGET_MODE}" = "all" ] || [ "${TARGET_MODE}" = "v1" ]; then
# -----------------------------------------------------------------------------
# 2. Test Generation 1 Python (ocrprox) - Host Mode
# -----------------------------------------------------------------------------
echo ""
echo "=========================================================================="
echo ">>> [Phase 1] Testing Gen 1 Python (ocrprox) - Host Linux VM"
echo "=========================================================================="

${PYTHON_BIN} ${BASE_DIR}/prepare_v1_config.py "${V1_CFG_DIR}"
export $(cat "${V1_CFG_DIR}/v1.env" | xargs)

cd "${V1_DIR}/vm-app"
nohup ${PYTHON_BIN} run_server.py > "${LOGS_DIR}/v1_server.log" 2>&1 &
V1_PID=$!
cd "${BASE_DIR}"

wait_url "http://127.0.0.1:8787/health" "Gen 1 Python Gateway"

sleep 2
INITIAL_RSS=$(grep -i VmRSS "/proc/${V1_PID}/status" 2>/dev/null | awk '{print $2}')
INITIAL_HWM=$(grep -i VmHWM "/proc/${V1_PID}/status" 2>/dev/null | awk '{print $2}')
INITIAL_FDS=$(ls -1 "/proc/${V1_PID}/fd" 2>/dev/null | wc -l)
echo "[Gen 1 Host] Startup Idle Memory: VmRSS=${INITIAL_RSS} KB ($((INITIAL_RSS/1024)) MB), VmHWM=${INITIAL_HWM} KB, FDs=${INITIAL_FDS}"

V1_SAMPLE_LOG="${RESULTS_DIR}/v1_memory_samples.log"
sample_memory "${V1_PID}" "${V1_SAMPLE_LOG}" &
SAMPLER_PID=$!

${PYTHON_BIN} ${BASE_DIR}/chaos_harness.py \
    --gateway-url "http://127.0.0.1:8787" \
    --concurrency 50 \
    --total-requests 100 \
    --output "${RESULTS_DIR}/v1_python_results.json"

kill ${SAMPLER_PID} 2>/dev/null || true

PEAK_HWM=$(grep -i VmHWM "/proc/${V1_PID}/status" 2>/dev/null | awk '{print $2}')
FINAL_RSS=$(grep -i VmRSS "/proc/${V1_PID}/status" 2>/dev/null | awk '{print $2}')
FINAL_FDS=$(ls -1 "/proc/${V1_PID}/fd" 2>/dev/null | wc -l)

echo "[Gen 1 Host] Post-test Memory: VmRSS=${FINAL_RSS} KB ($((FINAL_RSS/1024)) MB), Peak VmHWM=${PEAK_HWM} KB ($((PEAK_HWM/1024)) MB), FDs=${FINAL_FDS}"

cat <<EOF > "${RESULTS_DIR}/v1_metrics_summary.json"
{
  "generation": "v1-python",
  "mode": "host",
  "pid": ${V1_PID},
  "startup_vmrss_kb": ${INITIAL_RSS},
  "startup_vmrss_mb": $((INITIAL_RSS/1024)),
  "peak_vmhwm_kb": ${PEAK_HWM},
  "peak_vmhwm_mb": $((PEAK_HWM/1024)),
  "final_vmrss_kb": ${FINAL_RSS},
  "final_vmrss_mb": $((FINAL_RSS/1024)),
  "fds_open": ${FINAL_FDS}
}
EOF

kill "${V1_PID}" 2>/dev/null || true
sleep 1

# -----------------------------------------------------------------------------
# 3. Test Generation 1 Python in 64MB Container (NAT VM Simulation)
# -----------------------------------------------------------------------------
echo ""
echo "=========================================================================="
echo ">>> [Phase 2] Testing Gen 1 Python in 64MB Docker Container (Limit: 64MB)"
echo "=========================================================================="
kill_port 8787

CONTAINER_NAME="v1-python-64m-lab"
docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true

docker run -d --name "${CONTAINER_NAME}" \
    -m 64m --memory-swap 64m \
    --network host \
    -v "${BASE_DIR}:${BASE_DIR}" \
    -w "${V1_DIR}/vm-app" \
    -e ENCRYPT_KEY="${ENCRYPT_KEY}" \
    -e CONFIG_DIR="${V1_CFG_DIR}" \
    -e CLIENT_KEY="test-proxy-client-key-8888" \
    -e PROXY_API_KEY="test-proxy-client-key-8888" \
    -e ADMIN_PASSWORD="bench-admin-secret" \
    -e APP_PORT=8787 \
    -e APP_HOST=0.0.0.0 \
    -e UVICORN_LIMIT_CONCURRENCY=128 \
    python:3.13-slim \
    bash -c "PYTHONPATH=/data/home/bench/v1-python/.venv/lib/python3.13/site-packages python3 run_server.py"

sleep 3
CONTAINER_STATUS=$(docker inspect --format '{{.State.Status}}' "${CONTAINER_NAME}" 2>/dev/null || echo "not_found")

if [ "${CONTAINER_STATUS}" = "running" ]; then
    echo "Container is running. Firing load tests to check OOM vulnerability..."
    ${PYTHON_BIN} ${BASE_DIR}/chaos_harness.py \
        --gateway-url "http://127.0.0.1:8787" \
        --concurrency 50 \
        --total-requests 50 \
        --output "${RESULTS_DIR}/v1_container_results.json" || true

    EXIT_CODE=$(docker inspect --format '{{.State.ExitCode}}' "${CONTAINER_NAME}" 2>/dev/null || echo "0")
    OOM_KILLED=$(docker inspect --format '{{.State.OOMKilled}}' "${CONTAINER_NAME}" 2>/dev/null || echo "false")
    CONTAINER_POST_STATUS=$(docker inspect --format '{{.State.Status}}' "${CONTAINER_NAME}" 2>/dev/null || echo "unknown")

    echo "Post-load Container Status: ${CONTAINER_POST_STATUS}, ExitCode: ${EXIT_CODE}, OOMKilled: ${OOM_KILLED}"
    cat <<EOF > "${RESULTS_DIR}/v1_container_summary.json"
{
  "generation": "v1-python",
  "mode": "docker-64m",
  "container_name": "${CONTAINER_NAME}",
  "post_load_status": "${CONTAINER_POST_STATUS}",
  "exit_code": ${EXIT_CODE},
  "oom_killed": ${OOM_KILLED}
}
EOF
fi

docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
fi

if [ "${TARGET_MODE}" = "all" ] || [ "${TARGET_MODE}" = "v2" ]; then
# -----------------------------------------------------------------------------
# 4. Test Generation 2 Go (llmproxy2) - Host Mode
# -----------------------------------------------------------------------------
echo ""
echo "=========================================================================="
echo ">>> [Phase 3] Testing Gen 2 Go Gateway (llmproxy2 --role=lite)"
echo "=========================================================================="
GO_BIN="${BASE_DIR}/llmproxy2"
chmod +x "${GO_BIN}"

kill_port 8787
curl -s -X POST http://127.0.0.1:19001/admin/reset >/dev/null

echo "Starting Gen 2 Go Lite Gateway..."
export GOMEMLIMIT=48MiB
nohup "${GO_BIN}" \
    --role=lite \
    --port=8787 \
    --hub-url="http://127.0.0.1:19001" \
    --node-token="stk_node_bench_test_token_123" \
    --client-key="test-proxy-client-key-8888" \
    --allow-private > "${LOGS_DIR}/v2_lite_server.log" 2>&1 &
V2_PID=$!

wait_url "http://127.0.0.1:8787/healthz" "Gen 2 Go Gateway"

sleep 2
V2_INIT_RSS=$(grep -i VmRSS "/proc/${V2_PID}/status" 2>/dev/null | awk '{print $2}')
V2_INIT_HWM=$(grep -i VmHWM "/proc/${V2_PID}/status" 2>/dev/null | awk '{print $2}')
V2_INIT_FDS=$(ls -1 "/proc/${V2_PID}/fd" 2>/dev/null | wc -l)
echo "[Gen 2 Go Lite] Startup Idle Memory: VmRSS=${V2_INIT_RSS} KB ($((V2_INIT_RSS/1024)) MB), VmHWM=${V2_INIT_HWM} KB, FDs=${V2_INIT_FDS}"

# Zero-Disk and RLIMIT_CORE check
CORE_LIMIT=$(grep "Max core file size" "/proc/${V2_PID}/limits" | awk '{print $5}')
echo "[Security Check] Max core file size: ${CORE_LIMIT} bytes (Zero-core-dump confirmed: $([ "${CORE_LIMIT}" = "0" ] && echo "PASS" || echo "FAIL"))"

V2_SAMPLE_LOG="${RESULTS_DIR}/v2_memory_samples.log"
sample_memory "${V2_PID}" "${V2_SAMPLE_LOG}" &
V2_SAMPLER_PID=$!

# Run full Chaos Harness against Gen 2 Go
${PYTHON_BIN} ${BASE_DIR}/chaos_harness.py \
    --gateway-url "http://127.0.0.1:8787" \
    --concurrency 50 \
    --total-requests 100 \
    --output "${RESULTS_DIR}/v2_go_results.json"

kill ${V2_SAMPLER_PID} 2>/dev/null || true

# Peak memory during test
V2_PEAK_HWM=$(grep -i VmHWM "/proc/${V2_PID}/status" 2>/dev/null | awk '{print $2}')
V2_FINAL_RSS=$(grep -i VmRSS "/proc/${V2_PID}/status" 2>/dev/null | awk '{print $2}')
V2_FINAL_FDS=$(ls -1 "/proc/${V2_PID}/fd" 2>/dev/null | wc -l)

echo "[Gen 2 Go Lite] Post-test Memory: VmRSS=${V2_FINAL_RSS} KB ($((V2_FINAL_RSS/1024)) MB), Peak VmHWM=${V2_PEAK_HWM} KB ($((V2_PEAK_HWM/1024)) MB), FDs=${V2_FINAL_FDS}"

# Zero disk audit: verify no secrets leaked to disk
SECRET_LEAK_COUNT=$(grep -rn "sk-key-" "${LOGS_DIR}/v2*" /tmp 2>/dev/null | wc -l || true)
echo "[Security Check] Secret leak scan on disk: ${SECRET_LEAK_COUNT} occurrences (Zero-disk confirmed: $([ "${SECRET_LEAK_COUNT}" -eq 0 ] && echo "PASS" || echo "FAIL"))"

# Dual stack & readonly guard verification
IPV4_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8787/healthz")
IPV6_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://[::1]:8787/healthz")
READONLY_ADMIN=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8787/api/admin/usage")
READONLY_CFG=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8787/api/config")

echo "[Dual-Stack & Readonly] IPv4 Health: ${IPV4_HEALTH}, IPv6 Health: ${IPV6_HEALTH}, Readonly Admin: ${READONLY_ADMIN}, Readonly Config: ${READONLY_CFG}"

# High-concurrency Lazy-Once verification: send 200 concurrent requests via Python async and check hub count
HUB_BEFORE=$(curl -s http://127.0.0.1:19001/metrics | grep -o '"config_calls":[0-9]*' | cut -d: -f2)
${PYTHON_BIN} -c '
import asyncio, httpx
async def send_all():
    limits = httpx.Limits(max_keepalive_connections=60, max_connections=60)
    async with httpx.AsyncClient(limits=limits, timeout=10.0) as client:
        sem = asyncio.Semaphore(50)
        async def one():
            async with sem:
                await client.post("http://127.0.0.1:8787/v1/chat/completions",
                    headers={"Authorization": "Bearer test-proxy-client-key-8888"},
                    json={"model": "bench-model", "messages": [{"role": "user", "content": "ping"}], "stream": False})
        await asyncio.gather(*[one() for _ in range(200)])
asyncio.run(send_all())
'
HUB_AFTER=$(curl -s http://127.0.0.1:19001/metrics | grep -o '"config_calls":[0-9]*' | cut -d: -f2)
HUB_DELTA=$((HUB_AFTER - HUB_BEFORE))
echo "[Hub Lazy-Once Check] 200 concurrent requests sent -> Hub calls before: ${HUB_BEFORE}, after: ${HUB_AFTER}, delta: ${HUB_DELTA} (Zero-billing-leakage confirmed: $([ "${HUB_DELTA}" -eq 0 ] && echo "PASS" || echo "FAIL"))"

cat <<EOF > "${RESULTS_DIR}/v2_metrics_summary.json"
{
  "generation": "v2-go",
  "role": "lite",
  "pid": ${V2_PID},
  "startup_vmrss_kb": ${V2_INIT_RSS},
  "startup_vmrss_mb": $((V2_INIT_RSS/1024)),
  "peak_vmhwm_kb": ${V2_PEAK_HWM},
  "peak_vmhwm_mb": $((V2_PEAK_HWM/1024)),
  "final_vmrss_kb": ${V2_FINAL_RSS},
  "final_vmrss_mb": $((V2_FINAL_RSS/1024)),
  "fds_open": ${V2_FINAL_FDS},
  "core_limit_zero": $([ "${CORE_LIMIT}" = "0" ] && echo "true" || echo "false"),
  "zero_disk_leak": $([ "${SECRET_LEAK_COUNT}" -eq 0 ] && echo "true" || echo "false"),
  "ipv4_health": ${IPV4_HEALTH},
  "ipv6_health": ${IPV6_HEALTH},
  "readonly_guard_blocked": $([ "${READONLY_ADMIN}" = "403" ] && echo "true" || echo "false"),
  "hub_calls_delta_on_200_reqs": ${HUB_DELTA}
}
EOF

kill "${V2_PID}" 2>/dev/null || true
sleep 1

# -----------------------------------------------------------------------------
# 5. Test Generation 2 Go in 64MB Container (NAT VM Survival Test)
# -----------------------------------------------------------------------------
echo ""
echo "=========================================================================="
echo ">>> [Phase 4] Testing Gen 2 Go in 64MB Docker Container (Limit: 64MB)"
echo "=========================================================================="
kill_port 8787

V2_CONTAINER="v2-go-64m-lab"
docker rm -f "${V2_CONTAINER}" 2>/dev/null || true

echo "Starting container ${V2_CONTAINER} with strict 64MB memory limit..."
docker run -d --name "${V2_CONTAINER}" \
    -m 64m --memory-swap 64m \
    --network host \
    -v "${BASE_DIR}:${BASE_DIR}" \
    -e GOMEMLIMIT=36MiB \
    -e GOGC=50 \
    debian:bookworm-slim \
    "${GO_BIN}" \
        --role=lite \
        --port=8787 \
        --hub-url="http://127.0.0.1:19001" \
        --node-token="stk_node_bench_test_token_123" \
        --client-key="test-proxy-client-key-8888" \
        --allow-private

sleep 2
wait_url "http://127.0.0.1:8787/healthz" "Gen 2 Go Container Gateway"

echo "Container is running. Firing load tests to check 64MB container survival..."
${PYTHON_BIN} ${BASE_DIR}/chaos_harness.py \
    --gateway-url "http://127.0.0.1:8787" \
    --concurrency 50 \
    --total-requests 50 \
    --output "${RESULTS_DIR}/v2_container_results.json" || true

V2_EXIT_CODE=$(docker inspect --format '{{.State.ExitCode}}' "${V2_CONTAINER}" 2>/dev/null || echo "0")
V2_OOM_KILLED=$(docker inspect --format '{{.State.OOMKilled}}' "${V2_CONTAINER}" 2>/dev/null || echo "false")
V2_POST_STATUS=$(docker inspect --format '{{.State.Status}}' "${V2_CONTAINER}" 2>/dev/null || echo "unknown")

echo "Post-load Container Status: ${V2_POST_STATUS}, ExitCode: ${V2_EXIT_CODE}, OOMKilled: ${V2_OOM_KILLED}"

cat <<EOF > "${RESULTS_DIR}/v2_container_summary.json"
{
  "generation": "v2-go",
  "mode": "docker-64m",
  "container_name": "${V2_CONTAINER}",
  "post_load_status": "${V2_POST_STATUS}",
  "exit_code": ${V2_EXIT_CODE},
  "oom_killed": ${V2_OOM_KILLED}
}
EOF

docker rm -f "${V2_CONTAINER}" 2>/dev/null || true
fi

echo ""
echo "=========================================================================="
echo ">>> ALL BENCHMARKS COMPLETED!"
echo "=========================================================================="
ls -lh "${RESULTS_DIR}"
