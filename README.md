# PQTV — Панель управления IPTV-каналами и веб/TV-плеер

Полнофункциональный сервер управления IPTV-плейлистами, каталогом каналов и источниками потоков с веб-плеером (`/watch`), поддержкой пульта Android TV, автоматическим подбором лучшего рабочего потока и выбором режима хранения данных (**PostgreSQL**, **локальные файлы** или **Firebase Cloud**).

---

## Быстрая установка на сервер в 1 клик (с нуля)

Скрипт автоматической установки сам поставит все необходимые зависимости (`curl`, `git`, `openssl`, **Docker Engine + Docker Compose v2**), склонирует репозиторий в `/opt/pqtv`, сгенерирует случайные секреты (`SESSION_SECRET`, `APK_UPLOAD_TOKEN`, `POSTGRES_PASSWORD`), захеширует пароль администратора, поднимет **PostgreSQL 17 + PQTV**, откроет порт в файрволе и проверит работоспособность сервера.

**Скрипт установщика:** [install.sh](./install.sh)  
**Прямая ссылка (Raw GitHub):** `https://raw.githubusercontent.com/alexpikman/PQTV/main/install.sh`

### Интерактивная установка (рекомендуется)

Подключитесь к чистому Linux-серверу (Ubuntu, Debian, CentOS, Rocky, AlmaLinux, Fedora, Alpine) по SSH и выполните одну команду:

```bash
curl -fsSL https://raw.githubusercontent.com/alexpikman/PQTV/main/install.sh | sudo bash
```

### Полностью автоматическая установка без вопросов (`--yes`)

```bash
curl -fsSL https://raw.githubusercontent.com/alexpikman/PQTV/main/install.sh | sudo bash -s -- --yes
```

С заданием своего порта, email и пароля администратора:

```bash
curl -fsSL https://raw.githubusercontent.com/alexpikman/PQTV/main/install.sh | sudo bash -s -- \
  --yes \
  --port=3000 \
  --storage=postgres \
  --email=admin@example.com \
  --password='YourStrongPassword'
```

### Установка без Docker (Node.js 22 + systemd)

Если сервер работает в среде без поддержки Docker (например, LXC/OpenVZ):

```bash
curl -fsSL https://raw.githubusercontent.com/alexpikman/PQTV/main/install.sh | sudo bash -s -- --native
```

### Обновление уже установленного сервера (в 1 клик, без потери данных и `.env`)

```bash
curl -fsSL https://raw.githubusercontent.com/alexpikman/PQTV/main/install.sh | sudo bash -s -- --update
```

Все параметры скрипта можно посмотреть командой:

```bash
curl -fsSL https://raw.githubusercontent.com/alexpikman/PQTV/main/install.sh | bash -s -- --help
```

---

## Основные адреса после установки

| Назначение | URL |
|---|---|
| Вход в систему | `http://SERVER_IP:3000/login` |
| Панель администратора (редактор, каталог, настройки) | `http://SERVER_IP:3000/editor` |
| Веб-плеер и ТВ-интерфейс (поддержка пульта) | `http://SERVER_IP:3000/watch` |
| Проверка состояния сервиса (Healthcheck) | `http://SERVER_IP:3000/api/health` |

---

## Ручная установка с нуля (Docker Compose)

Подробная инструкция также доступна в [docs/DEPLOYMENT_DOCKER.md](./docs/DEPLOYMENT_DOCKER.md).

### Требования
- Linux-сервер с установленными `git`, `openssl`, **Docker Engine** и **Docker Compose v2**.

### Шаги установки
1. Клонируйте репозиторий:
   ```bash
   git clone https://github.com/alexpikman/PQTV.git
   cd PQTV
   ```
2. Создайте конфигурацию `.env`:
   ```bash
   cp .env.example .env
   ```
   Сгенерируйте случайные ключи и вставьте их в `SESSION_SECRET`, `APK_UPLOAD_TOKEN` и `POSTGRES_PASSWORD`:
   ```bash
   openssl rand -hex 32
   openssl rand -hex 32
   openssl rand -hex 24
   ```
3. Задайте свой `ADMIN_EMAIL` и сгенерируйте bcrypt-хеш пароля для `ADMIN_PASSWORD_HASH`:
   ```bash
   docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim sh -lc \
     'npm install --no-save bcryptjs >/dev/null 2>&1 && node --input-type=module -e "import bcrypt from \"bcryptjs\"; console.log(bcrypt.hashSync(\"ЗАМЕНИТЕ_НА_СВОЙ_ПАРОЛЬ\", 10))"'
   ```
4. Укажите режим хранения `PQTV_STORAGE_MODE=postgres` (или `local`) и запустите стек:
   ```bash
   docker compose up -d --build
   docker compose ps
   docker compose logs -f pqtv
   ```

---

## Ручной запуск для разработки (без Docker)

Требуется **Node.js >= 20** (рекомендуется **Node.js 22 LTS**).

```bash
git clone https://github.com/alexpikman/PQTV.git
cd PQTV
cp .env.example .env
npm install
npm run build
npm run dev
```

Проверка сборки и тестов:

```bash
npm run lint
npm test
npm run test:postgres
```

---

## Режимы хранения данных

Режим хранения можно задать при установке через `PQTV_STORAGE_MODE` или переключить позже в админ-панели (**«Настройки → Хранение информации»**):

- **`postgres` (рекомендуется для сервера)** — хранит каталог, плейлисты, пользователей, настройки и сессии в PostgreSQL (`DATABASE_URL` в Docker Compose подключается автоматически).
- **`local`** — хранит данные в локальных JSON/M3U файлах на сервере (`/app/data` и `/app/playlist`) без внешних баз данных.
- **`cloud`** — синхронизация с Firebase Firestore и авторизацией Google (параметры собственного Firebase-проекта задаются прямо в интерфейсе или через `.env`).

Для переноса данных со старого сервера используйте **«Экспортировать снимок (.json)»** и **«Импортировать снимок (.json)»** в разделе **«Настройки → Хранение информации»**.

---

## Управление сервером (Docker)

```bash
cd /opt/pqtv

# Просмотр логов в реальном времени
docker compose logs -f pqtv

# Статус контейнеров
docker compose ps

# Перезапуск
docker compose restart

# Остановка без удаления данных (не используйте -v!)
docker compose down
```
