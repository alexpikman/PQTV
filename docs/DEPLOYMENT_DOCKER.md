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
```

Вставьте два разных случайных значения в `SESSION_SECRET` и `APK_UPLOAD_TOKEN`. Задайте свой `ADMIN_EMAIL` и bcrypt-хеш пароля в `ADMIN_PASSWORD_HASH`. Не используйте демонстрационные значения.

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

## 4. Данные и обновления
Compose хранит `/app/data` и `/app/playlist` в отдельных постоянных Docker volumes. Пересборка контейнера не удаляет эти тома.

Обновление:
```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
```

**Не выполняйте `docker compose down -v`**, если нужно сохранить данные.

## 5. Локальное или облачное хранение на собственном сервере
Проект поддерживает переключение режима хранения в разделе админки **«Настройки → Хранение информации»** и через переменную окружения `PQTV_STORAGE_MODE`:

- **Локальное хранение (`PQTV_STORAGE_MODE=local`, рекомендуется для собственного сервера)**:
  - Все данные сохраняются локально на диске сервера в `/app/data` и `/app/playlist` (внутри Docker volumes `pqtv_data` и `pqtv_playlists`).
  - Firebase / Firestore и вход через Google полностью отключаются; вход в админ-панель и плеер выполняется по логину и паролю.
  - Перенос данных со старого облачного инстанса: откройте **«Настройки → Хранение информации»** на исходном сервере → **«Экспортировать снимок (.json)»**, затем на новом сервере загрузите этот файл через **«Импортировать снимок (.json)»**.
- **Облачное хранение (`PQTV_STORAGE_MODE=cloud`)**:
  - Использует Firebase Firestore; при переносе на собственный сервер можно указать параметры **собственного** проекта Firebase прямо в интерфейсе (без пересборки образа) или через переменные `FIREBASE_*` в `.env`.

Настройки режима хранения записываются в `/app/data/storage_settings.json` и имеют приоритет при запуске после сохранения через веб-интерфейс.

