# Установка PQTV на собственный сервер через Docker

## Требования
- Linux-сервер с Docker Engine и Docker Compose v2.
- Доступ по SSH.
- Открытый порт PQTV (по умолчанию 3000) либо reverse proxy.

## 1. Получить проект
```bash
git clone https://github.com/alexpikman/PQTV.git
cd PQTV
```

Для обновления существующей копии:
```bash
git pull --ff-only
```

## 2. Настроить секреты
```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Вставьте три разных случайных значения в `SESSION_SECRET`, `APK_UPLOAD_TOKEN` и `POSTGRES_PASSWORD`. Для `POSTGRES_PASSWORD` используйте hex-значение из `openssl rand -hex 32`, чтобы строка подключения PostgreSQL не требовала URL-кодирования. Задайте свой `ADMIN_EMAIL` и bcrypt-хеш пароля в `ADMIN_PASSWORD_HASH`. Не используйте демонстрационные значения.

Для генерации bcrypt-хеша из каталога проекта:
```bash
docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim sh -lc 'npm install --no-save bcryptjs >/dev/null && node --input-type=module -e "import bcrypt from \"bcryptjs\"; console.log(bcrypt.hashSync(\"ЗАМЕНИТЕ_НА_СВОЙ_ПАРОЛЬ\", 10))"'
```

## 3. Запустить
```bash
docker compose up -d --build
docker compose ps
docker compose logs -f pqtv
```

Откройте `http://SERVER_IP:3000` (или порт из `PQTV_PORT`).

## 4. PostgreSQL и данные
PostgreSQL запускается отдельным контейнером с постоянным volume `pqtv_postgres_data`. Порт PostgreSQL не публикуется на хост: к базе подключается только приложение внутри Docker-сети. При старте PQTV проверяет соединение, применяет SQL-миграции и импортирует известные JSON-хранилища из `/app/data` в `app_state`. Импорт идемпотентный: существующая запись PostgreSQL не перезаписывается, исходные JSON-файлы не удаляются.

Постоянные данные приложения и админки хранятся в PostgreSQL. M3U-плейлисты, резервные копии плейлистов, кэш индексов/EPG и APK-файлы остаются в файловых Docker volumes.

Резервная копия базы:
```bash
mkdir -p backups
docker compose exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "backups/pqtv-$(date -u +%Y%m%d-%H%M%S).dump"
```

Восстановление из дампа (перезаписывает содержимое базы; остановите PQTV и проверьте выбранный файл):
```bash
docker compose stop pqtv
docker compose exec -T postgres sh -lc 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < backups/ИМЯ_ФАЙЛА.dump
docker compose up -d pqtv
```

Обновление:
```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
```

**Не выполняйте `docker compose down -v`**, если нужно сохранить данные.

## 5. Важное замечание о завершении миграции
Перевод серверных JSON-хранилищ и сессий на PostgreSQL выполняется отдельными проверяемыми этапами. Клиентские операции, которые ранее обращались к Firestore, также должны быть переведены на серверные API до отключения Firestore. Не удаляйте исходный Firebase-проект и его данные до завершения переноса и проверки Google Sign-In.
