#!/bin/bash
# ==============================================================================
# LLMProxy2 一键安装、平滑升级与运维管理脚本 (Linux VM / systemd)
#
# 托管仓库: https://github.com/khc8655/ocrprox2
# 支持运行模式:
#   - full: 全功能本地网关 (Agent + KB 加速 + Web 管理控制台 + 本地加密配置)
#   - lite: 零落盘内存中继节点 (Zero-Disk In-Memory Relay, 由 EdgeOne Hub 同步)
# ==============================================================================

set -e

# 终端样式与颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

SCRIPT_VERSION="v20261118-02"
TARGET_DIR="/usr/local/bin"
BIN_NAME="llmproxy"
CTL_NAME="llmproxy-ctl"
PORT_HINT_FILE="/etc/default/llmproxy-port"
GITHUB_REPO="${GITHUB_REPO:-khc8655/ocrprox2}"

info()     { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()       { echo -e "${GREEN}[✓]${NC} $1"; }
warn()     { echo -e "${YELLOW}[!]${NC} $1"; }
error()    { echo -e "${RED}[✗]${NC} $1"; exit 1; }
highlight(){ echo -e "${CYAN}${BOLD}$1${NC}"; }

# 智能提权辅助函数
run_sudo() {
    if [[ $EUID -eq 0 ]]; then
        "$@"
    elif command -v sudo &>/dev/null; then
        sudo "$@"
    else
        "$@"
    fi
}

CURRENT_USER=$(whoami 2>/dev/null || id -un 2>/dev/null || echo "root")
AUTO_GENERATED_ADMIN_PASS=false

write_port_hint() {
    local port="$1"
    if [[ -n "$port" && "$port" =~ ^[0-9]+$ ]]; then
        run_sudo mkdir -p /etc/default 2>/dev/null || true
        printf '%s\n' "$port" | run_sudo tee "$PORT_HINT_FILE" >/dev/null 2>&1 || true
        run_sudo chmod 644 "$PORT_HINT_FILE" 2>/dev/null || true
    fi
}

# 随机安全字符串生成器
gen_random_str() {
    local len=${1:-16}
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c "$len" || \
    python3 -c "import secrets, string; print(''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range($len)))" 2>/dev/null || \
    date +%s%N | sha256sum 2>/dev/null | head -c "$len"
}

# 安全交互输入工具：支持 curl ... | bash 管道场景，探测真实控制终端
safe_read() {
    local prompt="$1"
    local var_name="$2"
    local input_val=""
    if [ -t 0 ]; then
        read -r -p "$prompt" input_val
    elif (exec </dev/tty) 2>/dev/null; then
        read -r -p "$prompt" input_val < /dev/tty
    else
        input_val=""
    fi
    printf -v "$var_name" '%s' "$input_val"
}

# 提取环境文件中的键值 (跨平台兼容 GNU/BSD)
get_env_val() {
    local file="$1"
    local key="$2"
    [[ -f "$file" ]] || return 1
    sed -n -E "s/^[[:space:]]*${key}=[[:space:]]*[\"']?([^\"'#]+)[\"']?.*/\1/p" "$file" 2>/dev/null | head -n 1
}

# 写入或更新环境文件中的键值 (无 sed 注入风险，全程 0600 权限保护)
set_env_val() {
    local file="$1"
    local key="$2"
    local val="$3"
    local tmp
    tmp=$(umask 077 && mktemp /tmp/llmproxy_env_XXXXXX)
    if run_sudo test -f "$file" 2>/dev/null; then
        run_sudo cat "$file" | KEY="$key" VAL="$val" awk '
            BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; found = 0 }
            {
                line = $0
                sub(/^[[:space:]]+/, "", line)
                if (!found && index(line, k "=") == 1) {
                    print k "=" v
                    found = 1
                } else {
                    print $0
                }
            }
            END {
                if (!found) {
                    print k "=" v
                }
            }
        ' > "$tmp"
    else
        printf '%s=%s\n' "$key" "$val" > "$tmp"
    fi
    run_sudo sh -c 'umask 077 && cat "$1" > "$2" && chmod 600 "$2"' _ "$tmp" "$file"
    rm -f "$tmp"
}

# 更新 systemd Environment="KEY=VAL" 行 (无 sed 分隔符注入风险，保持 0600 权限)
set_systemd_env_val() {
    local file="$1"
    local key="$2"
    local val="$3"
    local tmp
    tmp=$(umask 077 && mktemp /tmp/llmproxy_svc_XXXXXX)
    run_sudo cat "$file" | KEY="$key" VAL="$val" awk '
        BEGIN { prefix = "Environment=\"" ENVIRON["KEY"] "="; v = ENVIRON["VAL"] }
        index($0, prefix) == 1 {
            print prefix v "\""
            next
        }
        { print $0 }
    ' > "$tmp"
    run_sudo sh -c 'umask 077 && cat "$1" > "$2" && chmod 600 "$2"' _ "$tmp" "$file"
    rm -f "$tmp"
}

# 公网 IP 探测
# Bind address selection. Two modes only, like the 1st generation:
#   local  (default) -> 127.0.0.1:PORT, reachable only from this machine; expose it
#                       yourself with nginx/caddy/ssh -L if needed.
#   public           -> [::]:PORT (dual-stack wildcard), reachable from outside.
# This script never guesses or prints an external IP: publishing a port is out of scope.
addr_for_mode() {
    local mode="${1:-local}"
    local port="$2"
    if [[ "$mode" == "public" ]]; then
        echo "[::]:${port}"
    else
        echo "127.0.0.1:${port}"
    fi
}

# 网络出站调优 (IPv4 优先，防止大模型源站 IPv6 黑洞)
optimize_network_routing() {
    if [[ -f /etc/gai.conf ]]; then
        if grep -q "^#precedence ::ffff:0:0/96  100" /etc/gai.conf 2>/dev/null; then
            info "调优系统级 DNS 解析优先级 (启用 IPv4 优先)..."
            run_sudo sed -i.bak "s/#precedence ::ffff:0:0\/96  100/precedence ::ffff:0:0\/96  100/" /etc/gai.conf 2>/dev/null || true
            run_sudo rm -f /etc/gai.conf.bak 2>/dev/null || true
            ok "网络出站优先级已完成调优"
        fi
    fi
}

# ==============================================================================
# 帮助信息输出
# ==============================================================================
show_help() {
    echo "=============================================================================="
    echo "  LLMProxy2 一键部署与管理中心 (Linux VM & systemd)"
    echo "=============================================================================="
    echo "用法:"
    echo "  bash install.sh [选项] [命令]"
    echo ""
    echo "命令 (Commands):"
    echo "  upgrade                    平滑就地升级已安装服务 (Smooth in-place upgrade)"
    echo "  uninstall [--keep-config]  卸载 LLMProxy2 服务 (可选择保留配置)"
    echo ""
    echo "选项 (Options):"
    echo "  --role=<lite|full>         运行模式: lite (EdgeOne 内存中继) 或 full (全功能网关+后台) [默认: full]"
    echo "  --bin=<path>               使用本地指定的编译二进制文件"
    echo "  --version=<TAG>            指定下载的 GitHub Release 版本标签 [默认: latest]"
    echo "  --mirror=<URL>             前置自定义 GitHub 下载加速镜像 (如 https://ghfast.top)"
    echo "  -p, --port=<PORT>          服务监听端口 [默认: 8787]"
    echo "      --bind=<local|public>  监听范围: local=仅 127.0.0.1 (默认); public=0.0.0.0 对外"
    echo "  -k, --client-key=<KEY>     客户端接入 API Key (空则自动生成 sk-llmproxy-...)"
    echo "  -w, --admin-password=<PW>  管理控制台密码 (仅 full 模式，空则自动生成)"
    echo "      --admin-pass=<PW>      同 --admin-password"
    echo "      --encrypt-key=<KEY>    本地配置加密密钥 (仅 full 模式，默认使用管理密码)"
    echo "      --config-dir=<DIR>     配置文件存放目录 [默认: /etc/llmproxy]"
    echo "      --hub-url=<URL>        EdgeOne Hub URL (lite 必填；full 可选预填 Vault 同步源)"
    echo "      --node-token=<TOKEN>   节点授权通信 Token (lite 必填；full 可选预填 Vault 同步源)"
    echo "  -y, --yes                  非交互模式 (自动确认并使用默认或随机生成值)"
    echo "  -h, --help                 显示本帮助信息并退出"
    echo "=============================================================================="
}

# ==============================================================================
# 解析命令行参数 (100% 保持向后兼容)
# ==============================================================================
CLI_ACTION=""
CLI_ROLE=""
CLI_BIN=""
CLI_VERSION=""
CLI_MIRROR=""
CLI_HUB_URL=""
CLI_NODE_TOKEN=""
CLI_PORT=""
CLI_BIND=""
CLI_ADMIN_PASS=""
CLI_CLIENT_KEY=""
CLI_ENCRYPT_KEY=""
CLI_CONFIG_DIR=""
KEEP_CONFIG=false
NON_INTERACTIVE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --role=*)
            CLI_ROLE="${1#*=}"
            shift
            ;;
        --role)
            CLI_ROLE="$2"
            shift 2
            ;;
        --bin=*)
            CLI_BIN="${1#*=}"
            shift
            ;;
        --bin)
            CLI_BIN="$2"
            shift 2
            ;;
        --version=*)
            CLI_VERSION="${1#*=}"
            shift
            ;;
        --version)
            CLI_VERSION="$2"
            shift 2
            ;;
        --mirror=*)
            CLI_MIRROR="${1#*=}"
            shift
            ;;
        --mirror)
            CLI_MIRROR="$2"
            shift 2
            ;;
        --hub-url=*)
            CLI_HUB_URL="${1#*=}"
            shift
            ;;
        --hub-url)
            CLI_HUB_URL="$2"
            shift 2
            ;;
        --node-token=*)
            CLI_NODE_TOKEN="${1#*=}"
            shift
            ;;
        --node-token)
            CLI_NODE_TOKEN="$2"
            shift 2
            ;;
        -p|--port)
            CLI_PORT="$2"
            shift 2
            ;;
        --port=*)
            CLI_PORT="${1#*=}"
            shift
            ;;
        --bind)
            CLI_BIND="$2"
            shift 2
            ;;
        --bind=*)
            CLI_BIND="${1#*=}"
            shift
            ;;
        -w|--password|--admin-pass|--admin-password)
            CLI_ADMIN_PASS="$2"
            shift 2
            ;;
        --admin-password=*|--admin-pass=*|--password=*)
            CLI_ADMIN_PASS="${1#*=}"
            shift
            ;;
        -k|--client-key|--key)
            CLI_CLIENT_KEY="$2"
            shift 2
            ;;
        --client-key=*|--key=*)
            CLI_CLIENT_KEY="${1#*=}"
            shift
            ;;
        --encrypt-key)
            CLI_ENCRYPT_KEY="$2"
            shift 2
            ;;
        --encrypt-key=*)
            CLI_ENCRYPT_KEY="${1#*=}"
            shift
            ;;
        --config-dir)
            CLI_CONFIG_DIR="$2"
            shift 2
            ;;
        --config-dir=*)
            CLI_CONFIG_DIR="${1#*=}"
            shift
            ;;
        -y|--yes|--non-interactive)
            NON_INTERACTIVE=true
            shift
            ;;
        --upgrade|upgrade|update)
            CLI_ACTION="upgrade"
            shift
            ;;
        --uninstall|uninstall)
            CLI_ACTION="uninstall"
            shift
            ;;
        --keep-config)
            KEEP_CONFIG=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            warn "忽略未知参数: $1"
            shift
            ;;
    esac
done

if [[ -n "$CLI_ROLE" && "$CLI_ROLE" != "lite" && "$CLI_ROLE" != "full" ]]; then
    error "--role 参数必须为 'lite' 或 'full' (当前为: '$CLI_ROLE')"
fi

# ==============================================================================
# 安装状态检测
# ==============================================================================
is_installed() {
    if [[ -f "/etc/systemd/system/llmproxy-full.service" || -f "/etc/systemd/system/llmproxy-lite.service" ]]; then
        return 0
    fi
    # A binary alone is NOT an installation: the upgrade branch needs a unit to
    # learn the role, port and restart target, and it never writes a unit itself.
    # Left over binaries (e.g. after a partial uninstall) must go through the
    # fresh-install path, which recreates the unit.
    #
    # NOTE: config files alone are also NOT "installed" — `uninstall --keep-config`
    # deliberately leaves them behind. Only a unit file counts.
    return 1
}

# 自动推导已有环境路径
detect_existing_env_and_config() {
    EXISTING_ENV_FILE=""
    EXISTING_CONFIG_DIR=""
    
    for env_cand in "/etc/llmproxy/.env" "/opt/llmproxy/.env"; do
        if [[ -f "$env_cand" ]]; then
            EXISTING_ENV_FILE="$env_cand"
            break
        fi
    done
    if [[ -z "$EXISTING_ENV_FILE" && -f "/etc/systemd/system/llmproxy-full.service" ]]; then
        local env_from_svc
        env_from_svc=$(sed -n -E 's/^EnvironmentFile=[[:space:]]*//p' /etc/systemd/system/llmproxy-full.service 2>/dev/null | head -n 1)
        if [[ -n "$env_from_svc" && -f "$env_from_svc" ]]; then
            EXISTING_ENV_FILE="$env_from_svc"
        fi
    fi
    
    if [[ -n "$CLI_CONFIG_DIR" ]]; then
        EXISTING_CONFIG_DIR="$CLI_CONFIG_DIR"
    elif [[ -n "$EXISTING_ENV_FILE" ]]; then
        local dir_from_env
        dir_from_env=$(get_env_val "$EXISTING_ENV_FILE" "CONFIG_DIR" || true)
        if [[ -n "$dir_from_env" ]]; then
            EXISTING_CONFIG_DIR="$dir_from_env"
        elif [[ "$EXISTING_ENV_FILE" == "/etc/llmproxy/.env" ]]; then
            EXISTING_CONFIG_DIR="/etc/llmproxy"
        elif [[ "$EXISTING_ENV_FILE" == "/opt/llmproxy/.env" ]]; then
            EXISTING_CONFIG_DIR="/opt/llmproxy/config"
        else
            EXISTING_CONFIG_DIR=$(dirname "$EXISTING_ENV_FILE")
        fi
    elif [[ -d "/etc/llmproxy" ]]; then
        EXISTING_CONFIG_DIR="/etc/llmproxy"
    elif [[ -d "/opt/llmproxy/config" ]]; then
        EXISTING_CONFIG_DIR="/opt/llmproxy/config"
    else
        EXISTING_CONFIG_DIR="/etc/llmproxy"
    fi
}

# ==============================================================================
# 二进制文件检索与下载
# ==============================================================================

# Atomically replace the installed binary. `cp` straight onto a binary that is
# currently running fails with ETXTBSY ("Text file busy"), which broke in-place
# upgrades. Writing a sibling temp file and renaming over the target swaps the
# inode instead, so the running process keeps its old mapping and the next start
# picks up the new file.
install_binary_atomic() {
    local src="$1"
    local dst="$2"
    local tmp="${dst}.new.$$"
    run_sudo cp "$src" "$tmp" || { run_sudo rm -f "$tmp"; return 1; }
    run_sudo chmod 755 "$tmp" || { run_sudo rm -f "$tmp"; return 1; }
    run_sudo mv -f "$tmp" "$dst" || { run_sudo rm -f "$tmp"; return 1; }
    return 0
}

resolve_binary() {
    local target_bin="$1"
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || pwd)"
    local project_root
    project_root="$(cd "$script_dir/.." 2>/dev/null && pwd || pwd)"

    # 检测系统与架构
    local os
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    local arch
    arch="$(uname -m)"
    local goarch="amd64"
    case "$arch" in
        x86_64|amd64)
            goarch="amd64"
            ;;
        aarch64|arm64)
            goarch="arm64"
            ;;
        *)
            error "不支持的系统架构: $arch"
            ;;
    esac
    local binary_target_name="llmproxy-${os}-${goarch}"

    run_sudo mkdir -p "$(dirname "$target_bin")"

    # 1. 显式 CLI 参数指定二进制
    if [[ -n "$CLI_BIN" && -f "$CLI_BIN" ]]; then
        info "使用指定的本地二进制: $CLI_BIN"
        install_binary_atomic "$CLI_BIN" "$target_bin"
        ok "二进制已安装至 $target_bin"
        return 0
    fi

    # 2. 本地项目 dist 目录产物
    if [[ -f "$project_root/dist/$binary_target_name" ]]; then
        info "检测到本地编译产物: $project_root/dist/$binary_target_name"
        install_binary_atomic "$project_root/dist/$binary_target_name" "$target_bin"
        ok "本地产物已安装至 $target_bin"
        return 0
    elif [[ -f "$project_root/dist/llmproxy" ]]; then
        info "检测到本地编译产物: $project_root/dist/llmproxy"
        install_binary_atomic "$project_root/dist/llmproxy" "$target_bin"
        ok "本地产物已安装至 $target_bin"
        return 0
    fi

    # 3. 从 GitHub Release 下载
    local release_tag="${CLI_VERSION:-latest}"
    local release_base="https://github.com/${GITHUB_REPO}/releases/latest/download"
    if [[ -n "$release_tag" && "$release_tag" != "latest" ]]; then
        release_base="https://github.com/${GITHUB_REPO}/releases/download/${release_tag}"
        info "未检测到本地编译产物，准备从 GitHub Releases (${release_tag}) 下载..."
    else
        info "未检测到本地编译产物，准备从 GitHub Releases 下载最新发行版..."
    fi

    local tmp_bin
    tmp_bin=$(umask 077 && mktemp /tmp/llmproxy_bin_XXXXXX)
    local tmp_sha
    tmp_sha=$(umask 077 && mktemp /tmp/llmproxy_sha_XXXXXX)

    if ! command -v sha256sum &>/dev/null && ! command -v shasum &>/dev/null; then
        rm -f "$tmp_bin" "$tmp_sha"
        error "未检测到 sha256sum 或 shasum 工具，无法执行强制 SHA256 完整性校验"
    fi

    # SEC-05: 强制先从官方 GitHub 获取 SHA256SUMS 并解析目标产物哈希 (Fail-Closed)
    local official_sha_url="${release_base}/SHA256SUMS"
    local sha_candidates=("$official_sha_url")
    if [[ -n "$CLI_MIRROR" ]]; then
        sha_candidates+=("${CLI_MIRROR%/}/${official_sha_url}")
    fi

    local sha_ok=false
    for surl in "${sha_candidates[@]}"; do
        if curl -fsSL --connect-timeout 6 --max-time 20 "$surl" -o "$tmp_sha" 2>/dev/null; then
            sha_ok=true
            break
        fi
    done

    if [[ "$sha_ok" != "true" ]]; then
        rm -f "$tmp_bin" "$tmp_sha"
        error "无法获取官方 SHA256SUMS 校验清单，已中止安装以保障供应链安全"
    fi

    local exp_sha
    exp_sha=$(awk -v t="$binary_target_name" '$2 == t || $2 == "*"t { print tolower($1); exit }' "$tmp_sha" 2>/dev/null || true)
    if [[ -z "$exp_sha" || ! "$exp_sha" =~ ^[0-9a-f]{64}$ ]]; then
        rm -f "$tmp_bin" "$tmp_sha"
        error "SHA256SUMS 中未找到 ${binary_target_name} 的有效校验值，已中止安装"
    fi

    local dl_candidates=()
    if [[ -n "$CLI_MIRROR" ]]; then
        local custom_mirror="${CLI_MIRROR%/}"
        dl_candidates+=("${custom_mirror}/${release_base}/${binary_target_name}")
    fi
    dl_candidates+=(
        "${release_base}/${binary_target_name}"
        "https://ghfast.top/${release_base}/${binary_target_name}"
        "https://gh-proxy.com/${release_base}/${binary_target_name}"
    )

    local dl_ok=false
    for url in "${dl_candidates[@]}"; do
        info "尝试从 $url 下载..."
        if curl -fsSL --connect-timeout 8 --max-time 120 "$url" -o "$tmp_bin" 2>/dev/null; then
            dl_ok=true
            break
        fi
    done

    if [[ "$dl_ok" != "true" ]]; then
        rm -f "$tmp_bin" "$tmp_sha"
        error "无法从 GitHub 下载二进制包，请检查网络、使用 --mirror 指定镜像或通过 --bin=/path/to/binary 指定本地二进制"
    fi

    local act_sha=""
    if command -v sha256sum &>/dev/null; then
        act_sha=$(sha256sum "$tmp_bin" | awk '{print tolower($1)}')
    elif command -v shasum &>/dev/null; then
        act_sha=$(shasum -a 256 "$tmp_bin" | awk '{print tolower($1)}')
    fi
    if [[ -z "$act_sha" || "$act_sha" != "$exp_sha" ]]; then
        rm -f "$tmp_bin" "$tmp_sha"
        error "SHA256 校验失败！期望值: $exp_sha, 实际计算: ${act_sha:-empty}"
    fi
    ok "SHA256 校验通过 ($act_sha)"

    install_binary_atomic "$tmp_bin" "$target_bin"
    rm -f "$tmp_bin" "$tmp_sha"
    ok "二进制已成功安装至 $target_bin"
    return 0
}

# ==============================================================================
# 注册运维工具 /usr/local/bin/llmproxy-ctl 与 sudoers 规则
# ==============================================================================
setup_cli_and_sudoers() {
    local ctl_path="${TARGET_DIR}/${CTL_NAME}"
    local sudoers_file="/etc/sudoers.d/llmproxy"

    if [[ -d /etc/sudoers.d ]]; then
        # SEC-11 / P0-09: 通过 SUDO_USER 识别 curl | sudo bash 下的真实操作用户；
        # 绝不授予 llmproxy 服务运行账号任何 sudo 权限，仅授予无通配符的精确固定命令。
        local target_user="${SUDO_USER:-$(whoami 2>/dev/null || id -un 2>/dev/null || echo root)}"
        if [[ -n "$target_user" && "$target_user" != "root" && "$target_user" != "llmproxy" && "$target_user" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
            local expected_rule="${target_user} ALL=(root) NOPASSWD: /bin/systemctl restart llmproxy-full, /usr/bin/systemctl restart llmproxy-full, /bin/systemctl restart llmproxy-lite, /usr/bin/systemctl restart llmproxy-lite, /bin/systemctl stop llmproxy-full, /usr/bin/systemctl stop llmproxy-full, /bin/systemctl stop llmproxy-lite, /usr/bin/systemctl stop llmproxy-lite, /bin/systemctl start llmproxy-full, /usr/bin/systemctl start llmproxy-full, /bin/systemctl start llmproxy-lite, /usr/bin/systemctl start llmproxy-lite, /bin/systemctl status llmproxy-full --no-pager, /usr/bin/systemctl status llmproxy-full --no-pager, /bin/systemctl status llmproxy-lite --no-pager, /usr/bin/systemctl status llmproxy-lite --no-pager, /bin/systemctl daemon-reload, /usr/bin/systemctl daemon-reload, ${ctl_path} status, ${ctl_path} restart, ${ctl_path} upgrade, ${ctl_path} update, ${ctl_path} uninstall -y, ${ctl_path} uninstall --yes, ${ctl_path} uninstall -y --keep-config, ${ctl_path} uninstall --keep-config -y"
            local tmp_sudoers
            tmp_sudoers=$(umask 077 && mktemp /tmp/llmproxy_sudoers_XXXXXX)
            printf '%s\n' "$expected_rule" > "$tmp_sudoers"
            if ! command -v visudo &>/dev/null || visudo -cf "$tmp_sudoers" >/dev/null 2>&1; then
                run_sudo sh -c 'umask 0227 && cat "$1" > "$2" && chmod 440 "$2"' _ "$tmp_sudoers" "$sudoers_file" 2>/dev/null || true
            fi
            rm -f "$tmp_sudoers"
        else
            run_sudo rm -f "$sudoers_file" 2>/dev/null || true
        fi
    fi

    local tmp_ctl
    tmp_ctl=$(mktemp /tmp/llmproxy_ctl_XXXXXX)
    cat << 'EOF_CTL' > "$tmp_ctl"
#!/bin/bash
# ==============================================================================
# LLMProxy2 伴生命令行运维管理工具 (llmproxy-ctl)
# ==============================================================================
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

GITHUB_REPO="khc8655/ocrprox2"

run_cmd() {
    if [[ $EUID -eq 0 ]]; then
        "$@"
    elif command -v sudo &>/dev/null; then
        sudo "$@"
    else
        "$@"
    fi
}

# Atomically replace a running binary: `cp` onto a live inode fails with ETXTBSY
# ("Text file busy"). Copying to a sibling temp name and renaming over the target
# swaps the inode, so the running process keeps its mapping and the restart picks
# up the new file.
swap_binary() {
    local src="$1" dst="$2" tmp="${dst}.new.$$"
    run_cmd cp "$src" "$tmp" \
        && run_cmd chmod 755 "$tmp" \
        && run_cmd mv -f "$tmp" "$dst" \
        || { run_cmd rm -f "$tmp" 2>/dev/null; return 1; }
    return 0
}

detect_service() {
    if command -v systemctl &>/dev/null; then
        if systemctl is-active --quiet llmproxy-full 2>/dev/null; then
            echo "llmproxy-full"
            return 0
        fi
        if systemctl is-active --quiet llmproxy-lite 2>/dev/null; then
            echo "llmproxy-lite"
            return 0
        fi
        if [[ -f /etc/systemd/system/llmproxy-full.service ]]; then
            echo "llmproxy-full"
            return 0
        fi
        if [[ -f /etc/systemd/system/llmproxy-lite.service ]]; then
            echo "llmproxy-lite"
            return 0
        fi
    fi
    echo "llmproxy-full"
}

get_port() {
    local service="$1"
    local port="8787"
    if [[ -r /etc/default/llmproxy-port ]]; then
        local ph
        ph=$(tr -d '[:space:]' < /etc/default/llmproxy-port 2>/dev/null || true)
        if [[ "$ph" =~ ^[0-9]+$ ]]; then
            echo "$ph"
            return 0
        fi
    fi
    for env_file in "/etc/llmproxy/.env" "/opt/llmproxy/.env"; do
        if [[ -f "$env_file" ]]; then
            local p
            p=$(sed -n -E "s/^[[:space:]]*PORT=[[:space:]]*[\"']?([0-9]+)[\"']?.*/\1/p" "$env_file" 2>/dev/null | head -n 1)
            if [[ -z "$p" ]]; then
                p=$(sed -n -E "s/^[[:space:]]*LLMPROXY_ADDR=[^:]*:([0-9]+).*/\1/p" "$env_file" 2>/dev/null | head -n 1)
            fi
            if [[ -n "$p" ]]; then
                port="$p"
                echo "$port"
                return 0
            fi
        fi
    done
    if [[ -f "/etc/systemd/system/${service}.service" ]]; then
        local p
        p=$(sed -n -E "s/.*LLMPROXY_ADDR=[^:]*:([0-9]+).*/\1/p" "/etc/systemd/system/${service}.service" 2>/dev/null | head -n 1)
        if [[ -n "$p" ]]; then
            port="$p"
        fi
    fi
    echo "$port"
}

case "$1" in
    status)
        SERVICE="$(detect_service)"
        PORT="$(get_port "$SERVICE")"
        echo -e "${CYAN}${BOLD}================================================================${NC}"
        echo -e "  LLMProxy2 服务状态监控 (${BOLD}${SERVICE}${NC})"
        echo -e "${CYAN}${BOLD}================================================================${NC}"
        if command -v systemctl &>/dev/null; then
            systemctl status "$SERVICE" --no-pager || true
        fi
        echo ""
        echo -e "  🔍 正在检测 /healthz 端点 (http://127.0.0.1:${PORT}/healthz)..."
        HEALTH_RESP=$(curl -s -m 4 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)
        if echo "$HEALTH_RESP" | grep -q '"status"'; then
            STATUS=$(echo "$HEALTH_RESP" | sed -n -E 's/.*"status"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p')
            ROLE=$(echo "$HEALTH_RESP" | sed -n -E 's/.*"role"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p')
            VER=$(echo "$HEALTH_RESP" | sed -n -E 's/.*"semver"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p')
            echo -e "  ${GREEN}✔ 服务运行正常 (Status: ${STATUS:-ok}, Role: ${ROLE:-$SERVICE}, Semver: ${VER:-2.0.0})${NC}"
        else
            echo -e "  ${RED}✗ 服务未响应健康检查或未在运行 (端口: ${PORT})${NC}"
        fi
        echo ""
        echo -e "  服务监听端口 : ${BOLD}${PORT}${NC}"
        echo -e "  代理 API 端点: ${CYAN}http://127.0.0.1:${PORT}/v1${NC}"
        if [[ "$SERVICE" == *"full"* ]]; then
            echo -e "  本地管理控制台: ${CYAN}http://127.0.0.1:${PORT}/${NC}"
        fi
        echo -e "${CYAN}${BOLD}================================================================${NC}"
        ;;
    log|logs)
        shift
        SERVICE="$(detect_service)"
        LINES="100"
        if [[ -n "$1" && "$1" =~ ^[0-9]+$ ]]; then
            LINES="$1"
            shift
        fi
        if command -v journalctl &>/dev/null; then
            exec journalctl -u "$SERVICE" -n "$LINES" -f "$@"
        else
            echo "当前系统未检测到 journalctl 工具。"
            exit 1
        fi
        ;;
    restart)
        SERVICE="$(detect_service)"
        echo -e "正在平滑重启 ${BOLD}${SERVICE}${NC}..."
        run_cmd systemctl restart "$SERVICE"
        echo -e "${GREEN}✔ 重启指令已发送！${NC}"
        PORT="$(get_port "$SERVICE")"
        sleep 1
        if curl -s -m 3 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null | grep -q '"status"'; then
            echo -e "${GREEN}✔ 健康检查通过 (http://127.0.0.1:${PORT}/healthz)${NC}"
        else
            echo -e "${YELLOW}ℹ 服务已重启，自检正在初始化中...${NC}"
        fi
        ;;
    upgrade|update)
        shift
        SERVICE="$(detect_service)"
        echo -e "${CYAN}${BOLD}================================================================${NC}"
        echo -e "  正在升级 LLMProxy2 二进制 (${BOLD}${SERVICE}${NC})"
        echo -e "${CYAN}${BOLD}================================================================${NC}"
        OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
        ARCH="$(uname -m)"
        case "$ARCH" in
            x86_64|amd64) GOARCH="amd64" ;;
            aarch64|arm64) GOARCH="arm64" ;;
            *) echo -e "${RED}Error: Unsupported architecture: $ARCH${NC}"; exit 1 ;;
        esac

        TMP_DIR=$(umask 077 && mktemp -d /tmp/llmproxy_ctl_upgrade_XXXXXX)
        chmod 700 "$TMP_DIR"
        trap 'rm -rf "$TMP_DIR"' EXIT

        if ! command -v sha256sum &>/dev/null && ! command -v shasum &>/dev/null; then
            echo -e "${RED}错误: 未检测到 sha256sum 或 shasum，无法验证升级包完整性${NC}"
            exit 1
        fi

        BIN_TARGET="llmproxy-${OS}-${GOARCH}"
        BIN_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/${BIN_TARGET}"
        MIRROR_URL="https://ghfast.top/${BIN_URL}"
        SHA_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/SHA256SUMS"

        # SEC-05: 强制先从官方 GitHub 获取 SHA256SUMS (Fail-Closed)
        echo -e "正在从官方源获取 SHA256SUMS 校验清单..."
        if ! curl -fsSL --connect-timeout 8 --max-time 20 "$SHA_URL" -o "$TMP_DIR/SHA256SUMS" 2>/dev/null; then
            rm -rf "$TMP_DIR"
            echo -e "${RED}错误: 无法从官方 GitHub 获取 SHA256SUMS，已中止升级！${NC}"
            exit 1
        fi

        EXPECTED_SHA=$(awk -v t="$BIN_TARGET" '$2 == t || $2 == "*"t { print tolower($1); exit }' "$TMP_DIR/SHA256SUMS" 2>/dev/null || true)
        if [[ -z "$EXPECTED_SHA" || ! "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]]; then
            rm -rf "$TMP_DIR"
            echo -e "${RED}错误: SHA256SUMS 中未找到 ${BIN_TARGET} 的有效校验值，已中止升级！${NC}"
            exit 1
        fi

        echo -e "正在下载最新发行版 (${OS}/${GOARCH})..."
        if ! curl -fsSL --connect-timeout 10 --max-time 180 "$BIN_URL" -o "$TMP_DIR/llmproxy" 2>/dev/null; then
            if ! curl -fsSL --connect-timeout 8 --max-time 120 "$MIRROR_URL" -o "$TMP_DIR/llmproxy"; then
                rm -rf "$TMP_DIR"
                echo -e "${RED}错误: 二进制包下载失败！${NC}"
                exit 1
            fi
        fi

        ACTUAL_SHA=""
        if command -v sha256sum &>/dev/null; then
            ACTUAL_SHA=$(sha256sum "$TMP_DIR/llmproxy" | awk '{print tolower($1)}')
        elif command -v shasum &>/dev/null; then
            ACTUAL_SHA=$(shasum -a 256 "$TMP_DIR/llmproxy" | awk '{print tolower($1)}')
        fi
        if [[ -z "$ACTUAL_SHA" || "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
            rm -rf "$TMP_DIR"
            echo -e "${RED}错误: SHA256 校验失败！期望: $EXPECTED_SHA, 实际: ${ACTUAL_SHA:-empty}${NC}"
            exit 1
        fi
        chmod 755 "$TMP_DIR/llmproxy"
        echo -e "  ${GREEN}✔ SHA256 校验通过 (${ACTUAL_SHA:0:16}...)${NC}"

        echo -e "正在替换二进制并平滑重启服务..."
        if ! swap_binary "$TMP_DIR/llmproxy" /usr/local/bin/llmproxy; then
            echo -e "${RED}错误: 无法替换 /usr/local/bin/llmproxy (文件繁忙或被占用)${NC}"
            exit 1
        fi
        if [[ -f /opt/llmproxy/bin/llmproxy ]]; then
            swap_binary "$TMP_DIR/llmproxy" /opt/llmproxy/bin/llmproxy || true
        fi

        if command -v systemctl &>/dev/null; then
            run_cmd systemctl restart "$SERVICE"
        fi
        echo -e "${GREEN}${BOLD}✔ LLMProxy2 升级完成并已优雅重启！${NC}"

        PORT="$(get_port "$SERVICE")"
        sleep 1
        if curl -s -m 3 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null | grep -q '"status"'; then
            echo -e "  ${GREEN}✔ 健康检查验证成功 (http://127.0.0.1:${PORT}/healthz)${NC}"
        fi
        ;;
    uninstall)
        shift
        KEEP_CONFIG=false
        ASSUME_YES=0
        for arg in "$@"; do
            case "$arg" in
                --keep-config) KEEP_CONFIG=true ;;
                -y|--yes) ASSUME_YES=1 ;;
            esac
        done
        if [ "${ASSUME_YES:-0}" = "1" ]; then
            confirm="y"
        elif [ -t 0 ]; then
            read -r -p "确定要完全卸载 LLMProxy2 服务及二进制文件吗？[y/N]: " confirm
        elif (exec </dev/tty) 2>/dev/null; then
            read -r -p "确定要完全卸载 LLMProxy2 服务及二进制文件吗？[y/N]: " confirm </dev/tty
        else
            echo "错误: 当前为非交互终端，请使用 'llmproxy-ctl uninstall -y' 确认卸载。" >&2
            exit 1
        fi
        if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
            echo "已取消卸载。"
            exit 0
        fi
        echo -e "${YELLOW}正在停止并注销 LLMProxy 服务...${NC}"
        run_cmd systemctl stop llmproxy-full 2>/dev/null || true
        run_cmd systemctl stop llmproxy-lite 2>/dev/null || true
        run_cmd systemctl disable llmproxy-full 2>/dev/null || true
        run_cmd systemctl disable llmproxy-lite 2>/dev/null || true
        run_cmd rm -f /etc/systemd/system/llmproxy-full.service /etc/systemd/system/llmproxy-lite.service
        run_cmd systemctl daemon-reload 2>/dev/null || true

        run_cmd rm -f /usr/local/bin/llmproxy /opt/llmproxy/bin/llmproxy 2>/dev/null || true
        run_cmd rm -f /etc/sudoers.d/llmproxy /etc/default/llmproxy-port 2>/dev/null || true

        if [[ "$KEEP_CONFIG" == "true" ]]; then
            echo -e "${GREEN}✔ 配置文件已保留在现有配置目录${NC}"
        else
            HAS_CFG=false
            if run_cmd sh -c '[ -d /etc/llmproxy ] && [ -n "$(ls -A /etc/llmproxy 2>/dev/null)" ]' 2>/dev/null; then
                HAS_CFG=true
            elif run_cmd sh -c '[ -d /opt/llmproxy ] && [ -n "$(ls -A /opt/llmproxy 2>/dev/null)" ]' 2>/dev/null; then
                HAS_CFG=true
            fi
            if [[ "$HAS_CFG" == "true" ]]; then
                BK=$(umask 077 && mktemp -d /tmp/llmproxy_backup_XXXXXX)
                chmod 700 "$BK"
                [[ -d /etc/llmproxy ]] && run_cmd cp -r /etc/llmproxy "$BK/" 2>/dev/null || true
                [[ -d /opt/llmproxy ]] && run_cmd cp -r /opt/llmproxy "$BK/" 2>/dev/null || true
                run_cmd chmod -R go-rwx "$BK" 2>/dev/null || true
                echo -e "配置数据已安全归档至: $BK"
            fi
            run_cmd rm -rf /etc/llmproxy /opt/llmproxy 2>/dev/null || true
            echo -e "${GREEN}✔ 相关配置已清理完毕${NC}"
        fi
        run_cmd rm -f /usr/local/bin/llmproxy-ctl
        echo -e "${GREEN}${BOLD}✔ LLMProxy2 已完全卸载！${NC}"
        ;;
    *)
        echo -e "${CYAN}${BOLD}================================================================${NC}"
        echo -e "  LLMProxy2 命令行运维管理工具 (llmproxy-ctl)"
        echo -e "${CYAN}${BOLD}================================================================${NC}"
        echo "用法: llmproxy-ctl <命令> [选项]"
        echo ""
        echo "可用命令:"
        echo "  status                          查看服务运行状态与 /healthz 健康检查"
        echo "  log [lines]                     查看实时运行日志 (默认 100 行, Ctrl+C 退出)"
        echo "  restart                         平滑重启代理服务"
        echo "  upgrade                         从 GitHub Releases 升级最新版本并平滑重启"
        echo "  uninstall [-y] [--keep-config]  卸载 LLMProxy2 服务"
        echo -e "${CYAN}${BOLD}================================================================${NC}"
        ;;
esac
EOF_CTL

    # Atomic swap: `llmproxy-ctl upgrade` re-runs this installer, so the ctl script
    # may be the file bash is currently reading. `cp` onto it would truncate the
    # running script; a rename swaps the inode instead.
    local tmp_ctl_dst="${ctl_path}.new.$$"
    run_sudo cp "$tmp_ctl" "$tmp_ctl_dst"
    # llmproxy-ctl is a bash script: non-root users need read permission too
    # (mktemp is 600, so plain `chmod +x` would leave mode 711 and break `llmproxy-ctl status`).
    run_sudo chmod 755 "$tmp_ctl_dst"
    run_sudo mv -f "$tmp_ctl_dst" "$ctl_path"
    rm -f "$tmp_ctl"
    ok "管理命令 llmproxy-ctl 注册就绪 (${ctl_path})"
}

# ==============================================================================
# 安装/升级总结横幅输出 (凭据脱敏安全保护)
# ==============================================================================
print_summary_banner() {
    local role="$1"
    local port="$2"
    local client_key="$3"
    local env_file="$4"
    local healthy="$5"

    local bind_mode="${BIND_MODE:-local}"
    local reachable_ip="127.0.0.1"
    local reach_note=" (仅本机可访问；对外发布请用 nginx/caddy 反代或 ssh -L 转发)"
    if [[ "$bind_mode" == "public" ]]; then
        reachable_ip="<本机IP>"
        reach_note=" (已监听 0.0.0.0/${port}，可从外部访问)"
    fi

    local masked_key="sk-llmproxy-****"
    if [[ ${#client_key} -ge 12 ]]; then
        masked_key="${client_key:0:11}...${client_key: -4}"
    elif [[ -n "$client_key" ]]; then
        masked_key="sk-llmproxy-****"
    fi

    echo ""
    echo "=============================================================================="
    if [[ "$healthy" == "true" ]]; then
        echo -e "${GREEN}${BOLD}  🎉 LLMProxy2 (${role}) 部署成功并已正常启动！(${SCRIPT_VERSION})${NC}"
    else
        echo -e "${YELLOW}${BOLD}  ⚠️ LLMProxy2 (${role}) 服务已就绪，正在初始化启动中... (${SCRIPT_VERSION})${NC}"
    fi
    echo "=============================================================================="
    echo ""
    echo -e "  📌 运行模式 (Role)      : ${BOLD}${role}${NC}"
    echo -e "  💚 健康状态 (Health)    : $([ "$healthy" = "true" ] && echo -e "${GREEN}OK (healthy)${NC}" || echo -e "${YELLOW}STARTING (pending)${NC}")"
    echo -e "  🌐 监听端口 (Port)      : ${BOLD}${port}${NC}"
    echo -e "  🔑 客户端密钥 (Client)  : ${YELLOW}${masked_key}${NC} (已脱敏保护)"
    if [[ "$role" == "full" ]]; then
        # A password the caller passed in is already known to them; hiding it only
        # makes the output useless. Only an auto-generated one stays masked (with a
        # pointer to where it is stored).
        if [[ "$AUTO_GENERATED_ADMIN_PASS" == "true" ]]; then
            echo -e "  🔒 后台密码 (Admin)     : ${YELLOW}********${NC} (自动生成，已脱敏)"
            echo -e "  💡 查看后台密码: sudo grep '^ADMIN_PASSWORD=' ${env_file:-/etc/llmproxy/.env} | cut -d= -f2-"
        else
            echo -e "  🔒 后台密码 (Admin)     : ${BOLD}${FINAL_ADMIN_PASS}${NC} (你指定的密码)"
        fi
        echo -e "  📁 配置文件 (Config)    : ${BOLD}${env_file}${NC} (权限: 0600)"
        if [[ -n "$FINAL_HUB_URL" ]]; then
            echo -e "  🔗 Vault 中枢 (Hub)     : ${CYAN}${FINAL_HUB_URL}${NC} (已预绑定)"
        fi
        echo ""
        echo -e "  🌐 管理控制台 (Admin Web) : ${CYAN}http://${reachable_ip}:${port}/${NC}${reach_note}"
    fi
    echo -e "  🚀 代理端点 (Proxy Base)  : ${CYAN}http://${reachable_ip}:${port}/v1${NC}${reach_note}"
    echo ""
    echo -e "  🛠️  运维管理命令 (llmproxy-ctl):"
    echo -e "     查看服务状态与健康: ${BOLD}llmproxy-ctl status${NC}"
    echo -e "     查看实时运行日志:   ${BOLD}llmproxy-ctl log${NC}"
    echo -e "     平滑重启代理服务:   ${BOLD}llmproxy-ctl restart${NC}"
    echo -e "     一键升级最新版本:   ${BOLD}llmproxy-ctl upgrade${NC}"
    echo -e "     卸载清理代理服务:   ${BOLD}llmproxy-ctl uninstall [-y] [--keep-config]${NC}"
    echo "=============================================================================="
    echo ""
}

# 监听范围校验（尽早，避免各分支重复处理）。默认 local：只监听 127.0.0.1，
# 对外发布交给 nginx/caddy/ssh -L，本脚本不做任何 IP 探测。
if [[ -n "$CLI_BIND" ]]; then
    case "$CLI_BIND" in
        local|public) BIND_MODE="$CLI_BIND" ;;
        *) error "--bind 参数必须为 'local' 或 'public' (当前为: '$CLI_BIND')" ;;
    esac
else
    BIND_MODE="local"
fi

# ==============================================================================
# 分支 1: 安全卸载模式 (UNINSTALL MODE)
# ==============================================================================
if [[ "$CLI_ACTION" == "uninstall" ]]; then
    echo ""
    echo "=============================================================================="
    highlight "  LLMProxy2 卸载向导 (Uninstall Wizard)"
    echo "=============================================================================="
    echo ""
    if ! is_installed; then
        warn "未检测到已安装的 LLMProxy2 服务，无需卸载。"
        exit 0
    fi

    if [[ "$NON_INTERACTIVE" == "true" ]]; then
        CONFIRM="y"
    elif [ -t 0 ]; then
        read -r -p "确定要完全卸载 LLMProxy2 服务及二进制文件吗？[y/N]: " CONFIRM
    elif (exec </dev/tty) 2>/dev/null; then
        read -r -p "确定要完全卸载 LLMProxy2 服务及二进制文件吗？[y/N]: " CONFIRM </dev/tty
    else
        error "当前为非交互终端，请使用 'install.sh uninstall -y' 确认卸载。"
    fi
    if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
        info "已取消卸载。"
        exit 0
    fi

    info "正在停止并注销 LLMProxy 服务..."
    if command -v systemctl &>/dev/null; then
        run_sudo systemctl stop llmproxy-full 2>/dev/null || true
        run_sudo systemctl stop llmproxy-lite 2>/dev/null || true
        run_sudo systemctl disable llmproxy-full 2>/dev/null || true
        run_sudo systemctl disable llmproxy-lite 2>/dev/null || true
        run_sudo rm -f /etc/systemd/system/llmproxy-full.service /etc/systemd/system/llmproxy-lite.service
        run_sudo systemctl daemon-reload 2>/dev/null || true
    fi

    info "清理二进制与运维命令..."
    run_sudo rm -f "${TARGET_DIR}/${BIN_NAME}"
    run_sudo rm -f "${TARGET_DIR}/${CTL_NAME}"
    run_sudo rm -f "/opt/llmproxy/bin/llmproxy" 2>/dev/null || true
    run_sudo rm -f "/etc/sudoers.d/llmproxy" "$PORT_HINT_FILE" 2>/dev/null || true

    if [[ "$KEEP_CONFIG" == "true" ]]; then
        ok "服务已卸载，您的配置文件与密钥安全保留在现有配置目录中。"
    else
        HAS_CFG=false
        if run_sudo sh -c '[ -d /etc/llmproxy ] && [ -n "$(ls -A /etc/llmproxy 2>/dev/null)" ]' 2>/dev/null; then
            HAS_CFG=true
        elif run_sudo sh -c '[ -d /opt/llmproxy ] && [ -n "$(ls -A /opt/llmproxy 2>/dev/null)" ]' 2>/dev/null; then
            HAS_CFG=true
        fi
        if [[ "$HAS_CFG" == "true" ]]; then
            BACKUP_EXPORT=$(umask 077 && mktemp -d /tmp/llmproxy_backup_XXXXXX)
            chmod 700 "$BACKUP_EXPORT"
            [[ -d /etc/llmproxy ]] && run_sudo cp -r /etc/llmproxy "$BACKUP_EXPORT/" 2>/dev/null || true
            [[ -d /opt/llmproxy ]] && run_sudo cp -r /opt/llmproxy "$BACKUP_EXPORT/" 2>/dev/null || true
            run_sudo chmod -R go-rwx "$BACKUP_EXPORT" 2>/dev/null || true
            info "配置数据已安全归档备份至: $BACKUP_EXPORT"
        fi
        run_sudo rm -rf /etc/llmproxy /opt/llmproxy 2>/dev/null || true
        ok "LLMProxy2 已完全卸载！"
    fi
    echo ""
    exit 0
fi

# ==============================================================================
# 分支 2: 平滑升级模式 (UPGRADE MODE)
# ==============================================================================
if [[ "$CLI_ACTION" == "upgrade" ]] || is_installed; then
    echo ""
    echo "=============================================================================="
    highlight "  LLMProxy2 一键部署与管理中心 (Unified LLM Gateway)"
    echo "=============================================================================="
    echo ""
    echo -e "${GREEN}${BOLD}▶ 检测到已安装 LLMProxy2 服务，进入【平滑就地升级】流程${NC}"
    echo ""

    detect_existing_env_and_config
    CONFIG_DIR="$EXISTING_CONFIG_DIR"
    ENV_FILE="$EXISTING_ENV_FILE"
    if [[ -z "$ENV_FILE" ]]; then
        ENV_FILE="${CONFIG_DIR}/.env"
    fi

    # 检测运行角色 (优先读取已运行 systemd 服务)
    CURRENT_ROLE="full"
    if command -v systemctl &>/dev/null; then
        if systemctl is-active --quiet llmproxy-lite 2>/dev/null || [[ -f "/etc/systemd/system/llmproxy-lite.service" ]]; then
            CURRENT_ROLE="lite"
        elif systemctl is-active --quiet llmproxy-full 2>/dev/null || [[ -f "/etc/systemd/system/llmproxy-full.service" ]]; then
            CURRENT_ROLE="full"
        fi
    fi
    if [[ -n "$CLI_ROLE" ]]; then
        CURRENT_ROLE="$CLI_ROLE"
    fi
    FINAL_ROLE="$CURRENT_ROLE"

    # 读取旧凭据与端口
    # `|| true` on every probe: `get_env_val` returns 1 when the file is missing
    # (a fresh box that only still has the binary), and a bare `VAR=$(...)` would
    # inherit that status and kill the script under `set -e`.
    EXISTING_PORT=$(get_env_val "$ENV_FILE" "PORT" || true)
    if [[ -z "$EXISTING_PORT" ]]; then
        EXISTING_PORT=$(get_env_val "$ENV_FILE" "LLMPROXY_ADDR" | sed -n -E 's/.*:([0-9]+).*/\1/p' || true)
    fi
    [[ -z "$EXISTING_PORT" ]] && EXISTING_PORT="8787"

    EXISTING_PASS=$(get_env_val "$ENV_FILE" "ADMIN_PASSWORD" || true)
    EXISTING_ENC=$(get_env_val "$ENV_FILE" "ENCRYPT_KEY" || true)
    EXISTING_KEY=$(get_env_val "$ENV_FILE" "PROXY_API_KEY" || true)
    [[ -z "$EXISTING_KEY" ]] && EXISTING_KEY=$(get_env_val "$ENV_FILE" "LLMPROXY_CLIENT_KEY" || true)

    FINAL_PORT="${CLI_PORT:-$EXISTING_PORT}"
    FINAL_ADMIN_PASS="${CLI_ADMIN_PASS:-$EXISTING_PASS}"
    FINAL_ENCRYPT_KEY="${CLI_ENCRYPT_KEY:-$EXISTING_ENC}"
    FINAL_CLIENT_KEY="${CLI_CLIENT_KEY:-$EXISTING_KEY}"
    EXISTING_HUB_URL=$(get_env_val "$ENV_FILE" "LLMPROXY_HUB_URL" || true)
    EXISTING_NODE_TOKEN=$(get_env_val "$ENV_FILE" "LLMPROXY_NODE_TOKEN" || true)
    FINAL_HUB_URL="${CLI_HUB_URL:-$EXISTING_HUB_URL}"
    FINAL_NODE_TOKEN="${CLI_NODE_TOKEN:-$EXISTING_NODE_TOKEN}"

    info "当前服务运行模式: ${BOLD}${FINAL_ROLE}${NC}, 监听端口: ${BOLD}${FINAL_PORT}${NC}"

    # full 模式配置备份
    if [[ "$FINAL_ROLE" == "full" ]]; then
        run_sudo mkdir -p "$CONFIG_DIR"
        BACKUP_DIR="${CONFIG_DIR}/backup/backup_$(date +%Y%m%d_%H%M%S)"
        info "正在备份当前配置与密钥至 ${BACKUP_DIR}..."
        run_sudo mkdir -p "${BACKUP_DIR}"

        [[ -f "${CONFIG_DIR}/proxy_config.enc" ]] && run_sudo cp "${CONFIG_DIR}/proxy_config.enc" "${BACKUP_DIR}/"
        [[ -f "${CONFIG_DIR}/key_bans.json" ]] && run_sudo cp "${CONFIG_DIR}/key_bans.json" "${BACKUP_DIR}/"
        [[ -f "${ENV_FILE}" ]] && run_sudo cp "${ENV_FILE}" "${BACKUP_DIR}/"
        [[ -f "${CONFIG_DIR}/.env" && "${CONFIG_DIR}/.env" != "${ENV_FILE}" ]] && run_sudo cp "${CONFIG_DIR}/.env" "${BACKUP_DIR}/"

        run_sudo chmod 700 "${CONFIG_DIR}/backup" "${BACKUP_DIR}" 2>/dev/null || true

        # 仅保留最近 1 份备份，防止密钥扩散
        _llmproxy_bks=($(ls -1d "${CONFIG_DIR}"/backup/backup_* 2>/dev/null | sort))
        if [[ ${#_llmproxy_bks[@]} -gt 1 ]]; then
            for _old_bk in "${_llmproxy_bks[@]:0:${#_llmproxy_bks[@]}-1}"; do
                run_sudo rm -rf "$_old_bk"
            done
        fi
        ok "历史配置已完成安全备份 (仅保留最新 1 份)"

        # 保留并增量更新 .env 凭证 (umask 077 零暴露窗口)
        run_sudo mkdir -p "$(dirname "$ENV_FILE")"
        if [[ -f "$ENV_FILE" ]]; then
            # `|| true` keeps `set -e` from aborting the upgrade when an optional
            # flag was not supplied (a false `[[ ]] && cmd` is a non-zero status).
            if [[ -n "$CLI_PORT" ]]; then
                set_env_val "$ENV_FILE" "PORT" "$FINAL_PORT"
                set_env_val "$ENV_FILE" "LLMPROXY_ADDR" "$(addr_for_mode "$BIND_MODE" "$FINAL_PORT")"
            fi
            [[ -n "$CLI_ADMIN_PASS" ]] && set_env_val "$ENV_FILE" "ADMIN_PASSWORD" "$FINAL_ADMIN_PASS" || true
            [[ -n "$CLI_ENCRYPT_KEY" ]] && set_env_val "$ENV_FILE" "ENCRYPT_KEY" "$FINAL_ENCRYPT_KEY" || true
            if [[ -n "$CLI_CLIENT_KEY" ]]; then
                set_env_val "$ENV_FILE" "PROXY_API_KEY" "$FINAL_CLIENT_KEY"
                set_env_val "$ENV_FILE" "LLMPROXY_CLIENT_KEY" "$FINAL_CLIENT_KEY"
            fi
            [[ -n "$CLI_HUB_URL" ]] && set_env_val "$ENV_FILE" "LLMPROXY_HUB_URL" "$FINAL_HUB_URL" || true
            [[ -n "$CLI_NODE_TOKEN" ]] && set_env_val "$ENV_FILE" "LLMPROXY_NODE_TOKEN" "$FINAL_NODE_TOKEN" || true
            set_env_val "$ENV_FILE" "CONFIG_DIR" "$CONFIG_DIR"
            set_env_val "$ENV_FILE" "LLMPROXY_ROLE" "full"
        else
            TMP_ENV_FILE=$(umask 077 && mktemp /tmp/llmproxy_env_init_XXXXXX)
            (
                umask 077
                printf 'LLMPROXY_ROLE=full\n'
                printf 'PORT=%s\n' "$FINAL_PORT"
                printf 'LLMPROXY_ADDR=%s\n' "$(addr_for_mode "$BIND_MODE" "$FINAL_PORT")"
                printf 'CONFIG_DIR=%s\n' "$CONFIG_DIR"
                printf 'ADMIN_PASSWORD=%s\n' "$FINAL_ADMIN_PASS"
                printf 'ENCRYPT_KEY=%s\n' "$FINAL_ENCRYPT_KEY"
                printf 'PROXY_API_KEY=%s\n' "$FINAL_CLIENT_KEY"
                printf 'LLMPROXY_CLIENT_KEY=%s\n' "$FINAL_CLIENT_KEY"
                if [[ -n "$FINAL_HUB_URL" ]]; then printf 'LLMPROXY_HUB_URL=%s\n' "$FINAL_HUB_URL"; fi
                if [[ -n "$FINAL_NODE_TOKEN" ]]; then printf 'LLMPROXY_NODE_TOKEN=%s\n' "$FINAL_NODE_TOKEN"; fi
            ) > "$TMP_ENV_FILE"
            run_sudo sh -c 'umask 077 && cat "$1" > "$2" && chmod 600 "$2"' _ "$TMP_ENV_FILE" "$ENV_FILE"
            rm -f "$TMP_ENV_FILE"
        fi
        run_sudo chmod 600 "$ENV_FILE" 2>/dev/null || true
    elif [[ "$FINAL_ROLE" == "lite" && -f "/etc/systemd/system/llmproxy-lite.service" ]]; then
        SERVICE_FILE="/etc/systemd/system/llmproxy-lite.service"
        [[ -n "$CLI_PORT" ]] && set_systemd_env_val "$SERVICE_FILE" "LLMPROXY_ADDR" "$(addr_for_mode "$BIND_MODE" "$CLI_PORT")"
        [[ -n "$CLI_HUB_URL" ]] && set_systemd_env_val "$SERVICE_FILE" "LLMPROXY_HUB_URL" "$CLI_HUB_URL"
        [[ -n "$CLI_NODE_TOKEN" ]] && set_systemd_env_val "$SERVICE_FILE" "LLMPROXY_NODE_TOKEN" "$CLI_NODE_TOKEN"
        [[ -n "$CLI_CLIENT_KEY" ]] && set_systemd_env_val "$SERVICE_FILE" "LLMPROXY_CLIENT_KEY" "$CLI_CLIENT_KEY"
        run_sudo chmod 600 "$SERVICE_FILE" 2>/dev/null || true
    fi

    # 升级二进制
    resolve_binary "${TARGET_DIR}/${BIN_NAME}"
    if [[ -f /opt/llmproxy/bin/llmproxy ]]; then
        install_binary_atomic "${TARGET_DIR}/${BIN_NAME}" /opt/llmproxy/bin/llmproxy
    fi

    # 注册或更新全局 CLI 与免密规则，写入非机密端口提示文件
    write_port_hint "$FINAL_PORT"
    setup_cli_and_sudoers

    # 出站网络调优
    optimize_network_routing

    # 重启 systemd 服务
    if command -v systemctl &>/dev/null; then
        run_sudo systemctl daemon-reload
        info "正在平滑重启 llmproxy-${FINAL_ROLE} 服务..."
        run_sudo systemctl restart "llmproxy-${FINAL_ROLE}"
    fi

    # 健康检查 (轮询最多 10 秒)
    CHECK_SUCCESS=false
    if command -v systemctl &>/dev/null; then
        info "正在检验服务运行健康状态 (最多等待 10 秒: http://127.0.0.1:${FINAL_PORT}/healthz)..."
        for i in 1 2 3 4 5 6 7 8 9 10; do
            if curl -s -g "http://127.0.0.1:${FINAL_PORT}/healthz" 2>/dev/null | grep -q '"status"'; then
                CHECK_SUCCESS=true
                break
            fi
            sleep 1
        done
        if [[ "$CHECK_SUCCESS" == "true" ]]; then
            ok "健康自检通过！服务正常响应。"
        else
            warn "健康检查未在 10 秒内响应，请通过 'llmproxy-ctl status' 或 'llmproxy-ctl log' 查看服务状态。"
        fi
    fi

    # 打印总结 Banner
    print_summary_banner "$FINAL_ROLE" "$FINAL_PORT" "$FINAL_CLIENT_KEY" "$ENV_FILE" "$CHECK_SUCCESS"
    exit 0
fi

# ==============================================================================
# 分支 3: 全新安装模式 (FRESH INSTALL MODE)
# ==============================================================================
echo ""
echo "=============================================================================="
highlight "  LLMProxy2 一键部署与管理中心 (Unified LLM Gateway)"
echo "=============================================================================="
echo ""
echo -e "${CYAN}${BOLD}▶ 未检测到已安装服务，进入【全新一键安装】流程${NC}"
echo ""

# 出站网络调优
optimize_network_routing

# 判断是否需要进入交互向导
NEED_WIZARD=false
if [[ "$NON_INTERACTIVE" != "true" ]] && { [ -t 0 ] || (exec </dev/tty) 2>/dev/null; }; then
    if [[ -z "$CLI_ROLE" || -z "$CLI_PORT" || -z "$CLI_CLIENT_KEY" ]]; then
        NEED_WIZARD=true
    fi
fi

if [[ "$NEED_WIZARD" == "true" ]]; then
    echo -e "${CYAN}${BOLD}================================================================${NC}"
    echo -e "  🌟 LLMProxy2 交互式安装向导 (Interactive Setup Wizard)"
    echo -e "${CYAN}${BOLD}================================================================${NC}"
    echo ""

    # 1. 运行模式选择
    if [[ -n "$CLI_ROLE" ]]; then
        FINAL_ROLE="$CLI_ROLE"
    else
        echo -e "请选择运行模式 / Select Role:"
        echo -e "  1) lite - Zero-Disk In-Memory Relay (零落盘内存中继节点，由 Hub 统一纳管)"
        echo -e "  2) full - Full Gateway + Admin Web UI + KB (全功能独立网关+知识库) [默认/Default]"
        safe_read "请输入选项 [1/2] (默认: 2): " INPUT_ROLE
        if [[ "$INPUT_ROLE" == "1" || "$INPUT_ROLE" == "lite" ]]; then
            FINAL_ROLE="lite"
        else
            FINAL_ROLE="full"
        fi
    fi
    info "已设定运行模式: ${BOLD}${FINAL_ROLE}${NC}"

    # 2. 监听端口
    if [[ -n "$CLI_PORT" ]]; then
        FINAL_PORT="$CLI_PORT"
    else
        safe_read "请输入服务监听端口 / Enter listen port (默认: 8787): " INPUT_PORT
        FINAL_PORT="${INPUT_PORT:-8787}"
    fi
    info "已设定监听端口: ${BOLD}${FINAL_PORT}${NC}"

    # 3. 客户端密钥
    if [[ -n "$CLI_CLIENT_KEY" ]]; then
        FINAL_CLIENT_KEY="$CLI_CLIENT_KEY"
    else
        safe_read "请输入客户端接入密钥 / Enter client API key (直接回车自动生成 / Enter for auto): " INPUT_KEY
        if [[ -z "$INPUT_KEY" ]]; then
            FINAL_CLIENT_KEY="sk-llmproxy-$(gen_random_str 32)"
            info "已自动生成客户端密钥"
        else
            FINAL_CLIENT_KEY="$INPUT_KEY"
        fi
    fi

    # 4. 模式特异参数
    if [[ "$FINAL_ROLE" == "full" ]]; then
        if [[ -n "$CLI_ADMIN_PASS" ]]; then
            FINAL_ADMIN_PASS="$CLI_ADMIN_PASS"
        else
            safe_read "请输入管理控制台密码 / Enter admin password (直接回车自动生成 / Enter for auto): " INPUT_PASS
            if [[ -z "$INPUT_PASS" ]]; then
                FINAL_ADMIN_PASS="$(gen_random_str 24)"
                AUTO_GENERATED_ADMIN_PASS=true
                info "已自动生成管理员密码"
            else
                FINAL_ADMIN_PASS="$INPUT_PASS"
            fi
        fi

        if [[ -n "$CLI_ENCRYPT_KEY" ]]; then
            FINAL_ENCRYPT_KEY="$CLI_ENCRYPT_KEY"
        else
            safe_read "请输入本地配置加密密钥 / Enter encryption key (直接回车同管理员密码 / Enter for same): " INPUT_ENC
            if [[ -z "$INPUT_ENC" ]]; then
                FINAL_ENCRYPT_KEY="$FINAL_ADMIN_PASS"
            else
                FINAL_ENCRYPT_KEY="$INPUT_ENC"
            fi
        fi

        FINAL_CONFIG_DIR="${CLI_CONFIG_DIR:-/etc/llmproxy}"
        FINAL_HUB_URL="${CLI_HUB_URL}"
        FINAL_NODE_TOKEN="${CLI_NODE_TOKEN}"
        if [[ -z "$FINAL_HUB_URL" ]]; then
            safe_read "请输入 EdgeOne Hub URL (可选，用于 Vault 同步，直接回车跳过): " INPUT_FULL_HUB
            FINAL_HUB_URL="$INPUT_FULL_HUB"
        fi
        if [[ -n "$FINAL_HUB_URL" && -z "$FINAL_NODE_TOKEN" ]]; then
            safe_read "请输入节点授权 Token (例如 stk_node_...，直接回车跳过): " INPUT_FULL_TOK
            FINAL_NODE_TOKEN="$INPUT_FULL_TOK"
        fi
    else
        if [[ -n "$CLI_HUB_URL" ]]; then
            FINAL_HUB_URL="$CLI_HUB_URL"
        else
            safe_read "请输入 EdgeOne Hub URL (例如 https://hub.example.com): " INPUT_HUB
            FINAL_HUB_URL="$INPUT_HUB"
        fi

        if [[ -n "$CLI_NODE_TOKEN" ]]; then
            FINAL_NODE_TOKEN="$CLI_NODE_TOKEN"
        else
            safe_read "请输入节点授权 Token (例如 stk_node_...): " INPUT_NODE_TOKEN
            FINAL_NODE_TOKEN="$INPUT_NODE_TOKEN"
        fi
    fi
else
    FINAL_ROLE="${CLI_ROLE:-full}"
    FINAL_PORT="${CLI_PORT:-8787}"
    FINAL_CLIENT_KEY="${CLI_CLIENT_KEY:-sk-llmproxy-$(gen_random_str 32)}"
    if [[ -n "$CLI_ADMIN_PASS" ]]; then
        FINAL_ADMIN_PASS="$CLI_ADMIN_PASS"
    else
        FINAL_ADMIN_PASS="$(gen_random_str 24)"
        AUTO_GENERATED_ADMIN_PASS=true
    fi
    FINAL_ENCRYPT_KEY="${CLI_ENCRYPT_KEY:-$FINAL_ADMIN_PASS}"
    FINAL_CONFIG_DIR="${CLI_CONFIG_DIR:-/etc/llmproxy}"
    if [[ "$FINAL_ROLE" == "full" ]]; then
        FINAL_HUB_URL="${CLI_HUB_URL}"
        FINAL_NODE_TOKEN="${CLI_NODE_TOKEN}"
    else
        FINAL_HUB_URL="${CLI_HUB_URL:-https://your-hub.edgeone.app}"
        FINAL_NODE_TOKEN="${CLI_NODE_TOKEN:-stk_node_replace_me}"
    fi
fi

# 确定运行用户
RUN_AS_USER="llmproxy"
if command -v id &>/dev/null; then
    if ! id -u llmproxy &>/dev/null; then
        if [[ $EUID -eq 0 ]] && command -v useradd &>/dev/null; then
            useradd -r -s /bin/false -d /opt/llmproxy llmproxy 2>/dev/null || RUN_AS_USER="$CURRENT_USER"
        else
            RUN_AS_USER="$CURRENT_USER"
        fi
    fi
else
    RUN_AS_USER="$CURRENT_USER"
fi

# 检测是否运行在容器内（LXC/LXD/Docker 等非特权容器无法创建 mount namespace，
# 需要降级 systemd hardening 指令，否则服务会以 226/NAMESPACE 无限重启）
IS_CONTAINER=0
if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
    IS_CONTAINER=1
elif command -v systemd-detect-virt >/dev/null 2>&1 && systemd-detect-virt --container --quiet >/dev/null 2>&1; then
    IS_CONTAINER=1
elif grep -qa 'container=' /proc/1/environ 2>/dev/null; then
    IS_CONTAINER=1
fi

LITE_USER_BLOCK='DynamicUser=yes'
LITE_HARDENING=""
if [ "$IS_CONTAINER" -eq 0 ]; then
    LITE_HARDENING='ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
MemoryDenyWriteExecute=yes'
else
    # DynamicUser also requires a mount namespace; use a static unprivileged account.
    LITE_USER_BLOCK='User=nobody
Group=nogroup'
    LITE_HARDENING='# container detected: namespace-based hardening (ProtectSystem/ProtectHome/PrivateTmp) skipped
NoNewPrivileges=yes'
fi

# 监听地址由 FINAL_PORT + BIND_MODE 一次性定稿，供下方 .env 与 systemd 单元共用
BIND_ADDR="$(addr_for_mode "$BIND_MODE" "$FINAL_PORT")"

# 写入配置与服务单元
if [[ "$FINAL_ROLE" == "full" ]]; then
    CONFIG_DIR="$FINAL_CONFIG_DIR"
    ENV_FILE="${CONFIG_DIR}/.env"
    WORK_DIR="/opt/llmproxy"

    info "正在配置 Full 模式配置目录 (${CONFIG_DIR})..."
    run_sudo mkdir -p "$CONFIG_DIR" "$WORK_DIR"
    run_sudo chmod 700 "$CONFIG_DIR" 2>/dev/null || true

    TMP_ENV_FILE=$(umask 077 && mktemp /tmp/llmproxy_env_init_XXXXXX)
    (
        umask 077
        printf 'LLMPROXY_ROLE=full\n'
        printf 'PORT=%s\n' "$FINAL_PORT"
        printf 'LLMPROXY_ADDR=%s\n' "$(addr_for_mode "$BIND_MODE" "$FINAL_PORT")"
        printf 'CONFIG_DIR=%s\n' "$CONFIG_DIR"
        printf 'ADMIN_PASSWORD=%s\n' "$FINAL_ADMIN_PASS"
        printf 'ENCRYPT_KEY=%s\n' "$FINAL_ENCRYPT_KEY"
        printf 'PROXY_API_KEY=%s\n' "$FINAL_CLIENT_KEY"
        printf 'LLMPROXY_CLIENT_KEY=%s\n' "$FINAL_CLIENT_KEY"
        # `if` form, not `[[ ]] && printf`: the optional lines can be skipped, and a
        # false `[[ ]]` as the subshell's last command would make the whole block
        # return 1 under `set -e`, aborting a fresh full install with no node token.
        if [[ -n "$FINAL_HUB_URL" ]]; then printf 'LLMPROXY_HUB_URL=%s\n' "$FINAL_HUB_URL"; fi
        if [[ -n "$FINAL_NODE_TOKEN" ]]; then printf 'LLMPROXY_NODE_TOKEN=%s\n' "$FINAL_NODE_TOKEN"; fi
    ) > "$TMP_ENV_FILE"
    run_sudo sh -c 'umask 077 && cat "$1" > "$2" && chmod 600 "$2"' _ "$TMP_ENV_FILE" "$ENV_FILE"
    rm -f "$TMP_ENV_FILE"
    run_sudo chmod 600 "$ENV_FILE"
    run_sudo chown -R "${RUN_AS_USER}:${RUN_AS_USER}" "$CONFIG_DIR" "$WORK_DIR" 2>/dev/null || true

    SERVICE_FILE="/etc/systemd/system/llmproxy-full.service"
    info "正在写入 systemd 服务单元 (${SERVICE_FILE})..."
    cat << EOF | run_sudo tee "$SERVICE_FILE" >/dev/null
[Unit]
Description=LLMProxy2 Full Gateway (Agent + KB + Web Admin)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_AS_USER}
Group=${RUN_AS_USER}
WorkingDirectory=${WORK_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${TARGET_DIR}/${BIN_NAME} --role=full --config-dir=${CONFIG_DIR}
Restart=always
RestartSec=3
LimitNOFILE=65535
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

elif [[ "$FINAL_ROLE" == "lite" ]]; then
    ENV_FILE=""
    SERVICE_FILE="/etc/systemd/system/llmproxy-lite.service"
    info "正在写入 systemd 服务单元 (${SERVICE_FILE})..."
    TMP_SVC_FILE=$(umask 077 && mktemp /tmp/llmproxy_lite_svc_XXXXXX)
    (
        umask 077
        cat << EOF
[Unit]
Description=LLMProxy2 Lite Node (Zero-Disk In-Memory Relay)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${LITE_USER_BLOCK}
Environment="LLMPROXY_ROLE=lite"
Environment="LLMPROXY_ADDR=${BIND_ADDR}"
Environment="LLMPROXY_HUB_URL=${FINAL_HUB_URL}"
Environment="LLMPROXY_NODE_TOKEN=${FINAL_NODE_TOKEN}"
Environment="LLMPROXY_CLIENT_KEY=${FINAL_CLIENT_KEY}"
Environment="GOMEMLIMIT=48MiB"
ExecStart=${TARGET_DIR}/${BIN_NAME}
Restart=always
RestartSec=3

LimitCORE=0
${LITE_HARDENING}

[Install]
WantedBy=multi-user.target
EOF
    ) > "$TMP_SVC_FILE"
    run_sudo sh -c 'umask 077 && cat "$1" > "$2"' _ "$TMP_SVC_FILE" "$SERVICE_FILE"
    run_sudo chmod 600 "$SERVICE_FILE"
    rm -f "$TMP_SVC_FILE"
fi

# 安装二进制
resolve_binary "${TARGET_DIR}/${BIN_NAME}"

# 注册管理工具与免密规则，写入非机密端口提示文件
write_port_hint "$FINAL_PORT"
setup_cli_and_sudoers

# 启动并激活服务
if command -v systemctl &>/dev/null; then
    run_sudo systemctl daemon-reload
    run_sudo systemctl enable "llmproxy-${FINAL_ROLE}" 2>/dev/null || true
    info "正在启动服务 llmproxy-${FINAL_ROLE}..."
    run_sudo systemctl restart "llmproxy-${FINAL_ROLE}"
fi

# 运行健康自检 (最多等待 10 秒)
CHECK_SUCCESS=false
if command -v systemctl &>/dev/null; then
    info "正在检验服务运行健康状态 (最多等待 10 秒: http://127.0.0.1:${FINAL_PORT}/healthz)..."
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if curl -s -g "http://127.0.0.1:${FINAL_PORT}/healthz" 2>/dev/null | grep -q '"status"'; then
            CHECK_SUCCESS=true
            break
        fi
        sleep 1
    done
fi

# 打印总结 Banner
print_summary_banner "$FINAL_ROLE" "$FINAL_PORT" "$FINAL_CLIENT_KEY" "${ENV_FILE:-/etc/systemd/system/llmproxy-lite.service}" "$CHECK_SUCCESS"
exit 0
