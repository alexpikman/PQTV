#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# PQTV One-Click Server Installer & Updater
# Repository: https://github.com/alexpikman/PQTV
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/alexpikman/PQTV/main/install.sh | sudo bash
# ==============================================================================

REPO_URL="${PQTV_REPO_URL:-https://github.com/alexpikman/PQTV.git}"
BRANCH="${PQTV_BRANCH:-main}"
INSTALL_DIR="${PQTV_DIR:-/opt/pqtv}"
PQTV_PORT="${PQTV_PORT:-3000}"
ADMIN_EMAIL="${PQTV_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${PQTV_ADMIN_PASSWORD:-}"
STORAGE_MODE="${PQTV_STORAGE_MODE:-}"
INSTALL_MODE="docker"
NON_INTERACTIVE="${NONINTERACTIVE:-0}"
UPDATE_ONLY=0
GENERATED_PASSWORD=0

if [[ -t 1 ]]; then
  C_RESET='\033[0m'
  C_BOLD='\033[1m'
  C_BLUE='\033[1;34m'
  C_GREEN='\033[1;32m'
  C_YELLOW='\033[1;33m'
  C_RED='\033[1;31m'
else
  C_RESET=''
  C_BOLD=''
  C_BLUE=''
  C_GREEN=''
  C_YELLOW=''
  C_RED=''
fi

log_info()  { printf "${C_BLUE}[PQTV]${C_RESET} %s\n" "$*"; }
log_ok()    { printf "${C_GREEN}[OK]${C_RESET}   %s\n" "$*"; }
log_warn()  { printf "${C_YELLOW}[WARN]${C_RESET} %s\n" "$*"; }
log_err()   { printf "${C_RED}[ERR]${C_RESET}  %s\n" "$*" >&2; }

die() {
  log_err "$*"
  exit 1
}

usage() {
  cat <<'EOF'
PQTV — установщик и обновлятор сервера в 1 клик

Использование:
  install.sh [опции]

Опции:
  -y, --yes              Неинтерактивная установка со значениями по умолчанию
      --native           Установка без Docker (Node.js 22 + systemd)
      --update           Обновить существующую установку без сброса .env и данных
      --dir PATH         Каталог установки (по умолчанию: /opt/pqtv)
      --port PORT        Порт веб-интерфейса (по умолчанию: 3000)
      --storage MODE     Режим хранения: postgres | local (по умолчанию: postgres для Docker, local для --native)
      --email EMAIL      Email администратора
      --password PASS    Пароль администратора (если не указан в --yes, генерируется случайно)
      --branch BRANCH    Ветка Git (по умолчанию: main)
      --repo URL         URL Git-репозитория
  -h, --help             Показать эту справку
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes|--non-interactive)
      NON_INTERACTIVE=1
      shift
      ;;
    --native)
      INSTALL_MODE="native"
      shift
      ;;
    --update)
      UPDATE_ONLY=1
      shift
      ;;
    --dir)
      INSTALL_DIR="${2:?Требуется путь для --dir}"
      shift 2
      ;;
    --dir=*)
      INSTALL_DIR="${1#*=}"
      shift
      ;;
    --port)
      PQTV_PORT="${2:?Требуется порт для --port}"
      shift 2
      ;;
    --port=*)
      PQTV_PORT="${1#*=}"
      shift
      ;;
    --storage)
      STORAGE_MODE="${2:?Требуется режим (postgres|local) для --storage}"
      shift 2
      ;;
    --storage=*)
      STORAGE_MODE="${1#*=}"
      shift
      ;;
    --email)
      ADMIN_EMAIL="${2:?Требуется email для --email}"
      shift 2
      ;;
    --email=*)
      ADMIN_EMAIL="${1#*=}"
      shift
      ;;
    --password)
      ADMIN_PASSWORD="${2:?Требуется пароль для --password}"
      shift 2
      ;;
    --password=*)
      ADMIN_PASSWORD="${1#*=}"
      shift
      ;;
    --branch)
      BRANCH="${2:?Требуется имя ветки для --branch}"
      shift 2
      ;;
    --branch=*)
      BRANCH="${1#*=}"
      shift
      ;;
    --repo)
      REPO_URL="${2:?Требуется URL для --repo}"
      shift 2
      ;;
    --repo=*)
      REPO_URL="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Неизвестный параметр: $1. Используйте --help для справки."
      ;;
  esac
done

# Проверка ОС и прав root
if [[ "$(uname -s)" != "Linux" ]]; then
  die "Скрипт предназначен для Linux-серверов. На macOS/Windows используйте docker compose вручную."
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    die "Запустите скрипт с правами root (через sudo bash)."
  else
    die "Запустите скрипт от имени пользователя root."
  fi
fi

# Определение пакетного менеджера
PKG_MGR=""
if command -v apt-get >/dev/null 2>&1; then
  PKG_MGR="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG_MGR="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG_MGR="yum"
elif command -v pacman >/dev/null 2>&1; then
  PKG_MGR="pacman"
elif command -v apk >/dev/null 2>&1; then
  PKG_MGR="apk"
fi

# Проверка возможности интерактивного ввода (даже при запуске через curl | bash)
CAN_PROMPT=0
if [[ "$NON_INTERACTIVE" != "1" ]]; then
  if [[ -t 0 ]]; then
    CAN_PROMPT=1
  elif [[ -r /dev/tty && -w /dev/tty ]]; then
    CAN_PROMPT=1
  fi
fi

prompt_value() {
  local prompt_text="$1"
  local default_val="$2"
  local var_name="$3"
  local reply=""

  if [[ "$CAN_PROMPT" -eq 1 ]]; then
    if [[ -n "$default_val" ]]; then
      printf "%s [%s]: " "$prompt_text" "$default_val" >/dev/tty
    else
      printf "%s: " "$prompt_text" >/dev/tty
    fi
    IFS= read -r reply </dev/tty || reply=""
  fi
  if [[ -z "$reply" ]]; then
    reply="$default_val"
  fi
  printf -v "$var_name" '%s' "$reply"
}

prompt_secret() {
  local prompt_text="$1"
  local var_name="$2"
  local reply=""

  if [[ "$CAN_PROMPT" -eq 1 ]]; then
    printf "%s: " "$prompt_text" >/dev/tty
    IFS= read -rs reply </dev/tty || reply=""
    printf "\n" >/dev/tty
  fi
  printf -v "$var_name" '%s' "$reply"
}

prompt_yes_no() {
  local prompt_text="$1"
  local default_ans="$2" # y or n
  local reply=""
  if [[ "$CAN_PROMPT" -ne 1 ]]; then
    [[ "$default_ans" == "y" ]]
    return
  fi
  if [[ "$default_ans" == "y" ]]; then
    printf "%s [Y/n]: " "$prompt_text" >/dev/tty
  else
    printf "%s [y/N]: " "$prompt_text" >/dev/tty
  fi
  IFS= read -r reply </dev/tty || reply=""
  reply="${reply:-$default_ans}"
  [[ "$reply" =~ ^[YyДд]$ ]]
}

pkg_install() {
  case "$PKG_MGR" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq "$@"
      ;;
    dnf)
      dnf install -y -q "$@"
      ;;
    yum)
      yum install -y -q "$@"
      ;;
    pacman)
      pacman -Sy --noconfirm --needed "$@"
      ;;
    apk)
      apk add --no-cache "$@"
      ;;
    *)
      die "Не найден поддерживаемый пакетный менеджер (apt/dnf/yum/pacman/apk). Установите пакеты вручную: $*"
      ;;
  esac
}

ensure_base_deps() {
  log_info "[1/6] Проверка базовых зависимостей (git, curl, openssl, ca-certificates)..."
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v openssl >/dev/null 2>&1 || missing+=(openssl)

  if [[ "$PKG_MGR" == "apt" ]]; then
    dpkg -s ca-certificates >/dev/null 2>&1 || missing+=(ca-certificates)
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    log_info "Установка недостающих пакетов: ${missing[*]}"
    pkg_install "${missing[@]}"
  fi
  log_ok "Базовые зависимости готовы."
}

ensure_docker() {
  log_info "[2/6] Проверка Docker Engine и Docker Compose v2..."
  if ! command -v docker >/dev/null 2>&1; then
    log_info "Docker не найден — выполняется автоматическая установка Docker..."
    if [[ "$PKG_MGR" == "apk" ]]; then
      pkg_install docker docker-cli-compose
    else
      curl -fsSL https://get.docker.com | sh
    fi
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable docker >/dev/null 2>&1 || true
    systemctl start docker >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    service docker start >/dev/null 2>&1 || true
  fi

  if ! docker info >/dev/null 2>&1; then
    die "Демон Docker не запущен или недоступен (например, внутри OpenVZ/LXC без вложенной виртуализации). Попробуйте запуск с флагом --native."
  fi

  if ! docker compose version >/dev/null 2>&1; then
    log_info "Установка плагина Docker Compose v2..."
    if [[ "$PKG_MGR" == "apt" ]]; then
      pkg_install docker-compose-plugin
    elif [[ "$PKG_MGR" == "dnf" || "$PKG_MGR" == "yum" ]]; then
      pkg_install docker-compose-plugin
    elif [[ "$PKG_MGR" == "apk" ]]; then
      pkg_install docker-cli-compose
    else
      mkdir -p /usr/local/lib/docker/cli-plugins
      local arch
      arch="$(uname -m)"
      curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}" \
        -o /usr/local/lib/docker/cli-plugins/docker-compose
      chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    fi
    docker compose version >/dev/null 2>&1 || die "Не удалось активировать docker compose v2."
  fi
  log_ok "Docker и Docker Compose v2 готовы ($(docker compose version --short 2>/dev/null || echo 'ok'))."
}

ensure_nodejs_native() {
  log_info "[2/6] Проверка Node.js 22 LTS..."
  local need_node=0
  if ! command -v node >/dev/null 2>&1; then
    need_node=1
  else
    local major
    major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "${major:-0}" -lt 20 ]]; then
      need_node=1
    fi
  fi

  if [[ "$need_node" -eq 1 ]]; then
    log_info "Установка Node.js 22 LTS..."
    case "$PKG_MGR" in
      apt)
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        pkg_install nodejs
        ;;
      dnf|yum)
        curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
        pkg_install nodejs
        ;;
      apk)
        pkg_install nodejs npm
        ;;
      pacman)
        pkg_install nodejs npm
        ;;
      *)
        die "Установите Node.js >= 20 вручную и повторите запуск."
        ;;
    esac
  fi
  log_ok "Node.js готов ($(node -v), npm $(npm -v))."
}

sync_repository() {
  log_info "[3/6] Получение исходного кода PQTV в ${INSTALL_DIR}..."
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log_info "Найдена существующая установка — выполняется обновление ветки ${BRANCH}..."
    if [[ -f "${INSTALL_DIR}/.env" ]]; then
      cp -a "${INSTALL_DIR}/.env" "${INSTALL_DIR}/.env.bak"
    fi
    git -C "$INSTALL_DIR" fetch origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout "$BRANCH" >/dev/null 2>&1 || true
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
    if [[ -f "${INSTALL_DIR}/.env.bak" && ! -f "${INSTALL_DIR}/.env" ]]; then
      mv "${INSTALL_DIR}/.env.bak" "${INSTALL_DIR}/.env"
    else
      rm -f "${INSTALL_DIR}/.env.bak"
    fi
  else
    if [[ -d "$INSTALL_DIR" ]] && [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]]; then
      die "Каталог ${INSTALL_DIR} уже существует и не является Git-репозиторием. Укажите другой путь через --dir."
    fi
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  log_ok "Код PQTV загружен (${INSTALL_DIR})."
}

random_hex() {
  openssl rand -hex "${1:-32}"
}

random_password() {
  openssl rand -base64 18 | tr -dc 'A-Za-z0-9@#%_-' | head -c 16
}

read_env_var() {
  local key="$1"
  local env_file="$2"
  grep -E "^${key}=" "$env_file" 2>/dev/null | tail -n 1 | cut -d'=' -f2- || true
}

upsert_env_var() {
  local env_file="$1"
  local key="$2"
  local val="$3"
  local tmp_file="${env_file}.tmp"
  grep -v -E "^${key}=" "$env_file" > "$tmp_file" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp_file"
  mv "$tmp_file" "$env_file"
  chmod 600 "$env_file"
}

configure_env() {
  log_info "[4/6] Настройка конфигурации и секретов (.env)..."
  local env_file="${INSTALL_DIR}/.env"

  if [[ -f "$env_file" ]]; then
    if [[ "$UPDATE_ONLY" -eq 1 ]]; then
      log_ok "Сохранён существующий .env (--update)."
      PQTV_PORT="$(read_env_var "PQTV_PORT" "$env_file")"
      PQTV_PORT="${PQTV_PORT:-3000}"
      return 0
    fi
    if prompt_yes_no "Обнаружен существующий файл .env. Оставить текущие настройки и пароли?" "y"; then
      log_ok "Использован существующий файл .env."
      PQTV_PORT="$(read_env_var "PQTV_PORT" "$env_file")"
      PQTV_PORT="${PQTV_PORT:-3000}"
      return 0
    fi
    cp -a "$env_file" "${env_file}.backup.$(date +%Y%m%d%H%M%S)"
  fi

  if [[ -z "$STORAGE_MODE" ]]; then
    if [[ "$INSTALL_MODE" == "docker" ]]; then
      STORAGE_MODE="postgres"
    else
      STORAGE_MODE="local"
    fi
  fi

  if [[ "$CAN_PROMPT" -eq 1 ]]; then
    echo "" >/dev/tty
    printf "${C_BOLD}Настройка PQTV (нажмите Enter для значения по умолчанию):${C_RESET}\n" >/dev/tty
    prompt_value "Порт веб-сервера PQTV" "$PQTV_PORT" PQTV_PORT
    if [[ "$INSTALL_MODE" == "docker" ]]; then
      local mode_choice=""
      prompt_value "Режим хранения (postgres или local)" "$STORAGE_MODE" mode_choice
      case "$mode_choice" in
        postgres|local) STORAGE_MODE="$mode_choice" ;;
        *) log_warn "Неизвестный режим '${mode_choice}', выбран 'postgres'."; STORAGE_MODE="postgres" ;;
      esac
    fi
    prompt_value "Email администратора для входа" "${ADMIN_EMAIL:-admin@example.com}" ADMIN_EMAIL
    if [[ -z "$ADMIN_PASSWORD" ]]; then
      prompt_secret "Пароль администратора (Enter = сгенерировать автоматически)" ADMIN_PASSWORD
    fi
  else
    ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
  fi

  if ! [[ "$PQTV_PORT" =~ ^[0-9]+$ ]] || [[ "$PQTV_PORT" -lt 1 || "$PQTV_PORT" -gt 65535 ]]; then
    die "Некорректный порт: ${PQTV_PORT}"
  fi

  if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD="$(random_password)"
    GENERATED_PASSWORD=1
  fi

  local session_secret apk_token pg_pass
  session_secret="$(random_hex 32)"
  apk_token="$(random_hex 32)"
  pg_pass="$(random_hex 24)"

  cat > "$env_file" <<EOF
# Сгенерировано install.sh ($(date -u '+%Y-%m-%d %H:%M:%S UTC'))
PQTV_PORT=${PQTV_PORT}
PORT=${PQTV_PORT}

POSTGRES_DB=pqtv
POSTGRES_USER=pqtv
POSTGRES_PASSWORD=${pg_pass}

# Режим хранения: postgres | local | cloud
PQTV_STORAGE_MODE=${STORAGE_MODE}

SESSION_SECRET=${session_secret}
APK_UPLOAD_TOKEN=${apk_token}

ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD_HASH=PENDING_HASH

GITHUB_TOKEN=
GITHUB_REPO=
GITHUB_BRANCH=${BRANCH}
EOF

  if [[ "$INSTALL_MODE" == "native" && "$STORAGE_MODE" == "postgres" ]]; then
    local native_db_url="${DATABASE_URL:-}"
    if [[ -z "$native_db_url" ]]; then
      native_db_url="postgresql://pqtv:${pg_pass}@127.0.0.1:5432/pqtv"
    fi
    upsert_env_var "$env_file" "DATABASE_URL" "$native_db_url"
  fi

  chmod 600 "$env_file"
  log_ok "Конфигурация .env подготовлена."
}

configure_firewall() {
  local port="$1"
  if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | grep -qi "Status: active"; then
      ufw allow "${port}/tcp" >/dev/null 2>&1 || true
      log_ok "Открыт порт ${port}/tcp в UFW."
    fi
  elif command -v firewall-cmd >/dev/null 2>&1; then
    if systemctl is-active --quiet firewalld 2>/dev/null; then
      firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
      firewall-cmd --reload >/dev/null 2>&1 || true
      log_ok "Открыт порт ${port}/tcp в firewalld."
    fi
  fi
}

deploy_docker() {
  log_info "[5/6] Сборка контейнеров PQTV и настройка пароля администратора..."
  cd "$INSTALL_DIR"
  docker compose build pqtv

  local env_file="${INSTALL_DIR}/.env"
  local current_hash
  current_hash="$(read_env_var "ADMIN_PASSWORD_HASH" "$env_file")"
  if [[ "$current_hash" == "PENDING_HASH" || -z "$current_hash" ]]; then
    local bcrypt_hash
    bcrypt_hash="$(
      docker run --rm --entrypoint node -e PW="$ADMIN_PASSWORD" pqtv:local \
        --input-type=module -e "import bcrypt from 'bcryptjs'; process.stdout.write(bcrypt.hashSync(process.env.PW, 10));"
    )"
    [[ -n "$bcrypt_hash" ]] || die "Не удалось сгенерировать bcrypt-хеш пароля."
    upsert_env_var "$env_file" "ADMIN_PASSWORD_HASH" "$bcrypt_hash"
  fi

  configure_firewall "$PQTV_PORT"
  log_info "Запуск сервисов Docker Compose (postgres + pqtv)..."
  docker compose up -d --remove-orphans
  log_ok "Контейнеры запущены."
}

setup_native_postgres_if_needed() {
  if [[ "$STORAGE_MODE" != "postgres" ]]; then
    return 0
  fi
  if [[ -n "${DATABASE_URL:-}" ]]; then
    return 0
  fi

  log_info "Настройка локального PostgreSQL для нативной установки..."
  if ! command -v psql >/dev/null 2>&1; then
    case "$PKG_MGR" in
      apt) pkg_install postgresql postgresql-contrib ;;
      dnf|yum) pkg_install postgresql-server postgresql ;;
      *) die "Установите PostgreSQL вручную или используйте --storage local / Docker-режим." ;;
    esac
  fi

  if [[ "$PKG_MGR" == "dnf" || "$PKG_MGR" == "yum" ]] && [[ ! -d /var/lib/pgsql/data/base ]]; then
    postgresql-setup --initdb >/dev/null 2>&1 || true
  fi
  systemctl enable --now postgresql >/dev/null 2>&1 || service postgresql start >/dev/null 2>&1 || true

  local pg_pass
  pg_pass="$(read_env_var "POSTGRES_PASSWORD" "${INSTALL_DIR}/.env")"
  su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='pqtv'\"" | grep -q 1 || \
    su - postgres -c "psql -c \"CREATE USER pqtv WITH PASSWORD '${pg_pass}';\""
  su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='pqtv'\"" | grep -q 1 || \
    su - postgres -c "psql -c \"CREATE DATABASE pqtv OWNER pqtv;\""
  log_ok "База PostgreSQL (pqtv) готова."
}

deploy_native() {
  log_info "[5/6] Сборка проекта и настройка systemd-сервиса..."
  cd "$INSTALL_DIR"
  npm install
  npm run build

  local env_file="${INSTALL_DIR}/.env"
  local current_hash
  current_hash="$(read_env_var "ADMIN_PASSWORD_HASH" "$env_file")"
  if [[ "$current_hash" == "PENDING_HASH" || -z "$current_hash" ]]; then
    local bcrypt_hash
    bcrypt_hash="$(
      PW="$ADMIN_PASSWORD" node --input-type=module \
        -e "import bcrypt from 'bcryptjs'; process.stdout.write(bcrypt.hashSync(process.env.PW, 10));"
    )"
    [[ -n "$bcrypt_hash" ]] || die "Не удалось сгенерировать bcrypt-хеш пароля."
    upsert_env_var "$env_file" "ADMIN_PASSWORD_HASH" "$bcrypt_hash"
  fi

  setup_native_postgres_if_needed

  mkdir -p "${INSTALL_DIR}/data" "${INSTALL_DIR}/data/cache" "${INSTALL_DIR}/data/backups/playlist" "${INSTALL_DIR}/playlist"
  if id -u pqtv >/dev/null 2>&1 || useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin pqtv >/dev/null 2>&1; then
    chown -R pqtv:pqtv "$INSTALL_DIR"
  fi

  local node_bin service_user="root"
  node_bin="$(command -v node)"
  id -u pqtv >/dev/null 2>&1 && service_user="pqtv"

  cat > /etc/systemd/system/pqtv.service <<EOF
[Unit]
Description=PQTV IPTV Server
After=network.target postgresql.service

[Service]
Type=simple
User=${service_user}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
Environment=NODE_ENV=production
ExecStart=${node_bin} ${INSTALL_DIR}/dist/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  configure_firewall "$PQTV_PORT"
  systemctl daemon-reload
  systemctl enable pqtv
  systemctl restart pqtv
  log_ok "Системная служба pqtv.service запущена."
}

wait_for_health() {
  log_info "[6/6] Ожидание готовности сервера (http://127.0.0.1:${PQTV_PORT}/api/health)..."
  local ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PQTV_PORT}/api/health" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 2
  done

  if [[ "$ok" -eq 1 ]]; then
    log_ok "Сервер PQTV успешно отвечает!"
  else
    log_warn "Сервер запускается дольше обычного. Проверьте логи:"
    if [[ "$INSTALL_MODE" == "docker" ]]; then
      log_warn "  cd ${INSTALL_DIR} && docker compose logs -f pqtv"
    else
      log_warn "  journalctl -u pqtv -f"
    fi
  fi
}

detect_server_ip() {
  local ip=""
  ip="$(curl -4 -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
  if [[ -z "$ip" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  echo "${ip:-SERVER_IP}"
}

print_summary() {
  local server_ip
  server_ip="$(detect_server_ip)"

  echo ""
  printf "${C_GREEN}${C_BOLD}==========================================================${C_RESET}\n"
  printf "${C_GREEN}${C_BOLD}  PQTV успешно установлен и запущен!${C_RESET}\n"
  printf "${C_GREEN}${C_BOLD}==========================================================${C_RESET}\n"
  echo "  Каталог:       ${INSTALL_DIR}"
  echo "  Режим:         ${INSTALL_MODE} (хранилище: ${STORAGE_MODE:-из .env})"
  echo "  Вход/Админка:  http://${server_ip}:${PQTV_PORT}/login"
  echo "  Редактор:      http://${server_ip}:${PQTV_PORT}/editor"
  echo "  ТВ-плеер:      http://${server_ip}:${PQTV_PORT}/watch"
  echo "  Healthcheck:   http://${server_ip}:${PQTV_PORT}/api/health"
  echo ""
  if [[ "$UPDATE_ONLY" -eq 0 && -n "$ADMIN_EMAIL" ]]; then
    echo "  Email админа:  ${ADMIN_EMAIL}"
    if [[ "$GENERATED_PASSWORD" -eq 1 ]]; then
      echo "  Пароль:        ${ADMIN_PASSWORD}  (сохраните его — в .env записан только bcrypt-хеш)"
    fi
    echo ""
  fi
  echo "Полезные команды:"
  if [[ "$INSTALL_MODE" == "docker" ]]; then
    echo "  Логи:          cd ${INSTALL_DIR} && docker compose logs -f pqtv"
    echo "  Статус:        cd ${INSTALL_DIR} && docker compose ps"
    echo "  Перезапуск:    cd ${INSTALL_DIR} && docker compose restart"
  else
    echo "  Логи:          journalctl -u pqtv -f"
    echo "  Статус:        systemctl status pqtv"
    echo "  Перезапуск:    systemctl restart pqtv"
  fi
  echo "  Обновление:    curl -fsSL https://raw.githubusercontent.com/alexpikman/PQTV/main/install.sh | sudo bash -s -- --update"
  printf "${C_GREEN}${C_BOLD}==========================================================${C_RESET}\n"
}

ensure_base_deps
if [[ "$INSTALL_MODE" == "docker" ]]; then
  ensure_docker
else
  ensure_nodejs_native
fi
sync_repository
configure_env
if [[ "$INSTALL_MODE" == "docker" ]]; then
  deploy_docker
else
  deploy_native
fi
wait_for_health
print_summary
