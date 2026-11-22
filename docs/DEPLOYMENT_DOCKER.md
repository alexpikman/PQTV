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

## 5. Ограничение текущей версии хранения
Docker обеспечивает запуск приложения на вашем сервере и сохранение файловых данных в постоянных томах. Он не превращает файловые модули в PostgreSQL и не переносит данные Firestore.

Текущая кодовая база содержит клиентскую интеграцию Firestore и отдельные серверные файловые хранилища. До завершения отдельной адаптации и проверки нельзя утверждать, что все сущности работают исключительно на локальной БД или что облачная синхронизация отключена. Не удаляйте исходный Firebase-проект и его данные: миграция источника истины должна выполняться отдельным проверяемым этапом.
