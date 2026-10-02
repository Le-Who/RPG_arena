# pgvector для локальных агентов и проверок (v2.7)

Миграция `drizzle/0006_database_memory_search.sql` является частью уже применяемой истории схемы. Она включает `vector` (pgvector) и `pgcrypto`; readiness проверяет этот контракт. Ошибка `extension "vector" is not available` означает, что выбранный экземпляр PostgreSQL не содержит расширение. Исправлять локальное окружение изменением `0006`, записи журнала Drizzle или ослаблением readiness нельзя: так разные базы получат разную схему при одном номере миграции.

## Без системной установки PostgreSQL

После `npm ci` запускайте `npm test` или отдельно `node --import tsx --import ./tests/helpers/test-environment.ts --test tests/deploy-migrations.test.ts tests/database-memory-search.test.ts`. В lockfile уже закреплены PGlite и `@electric-sql/pglite-pgvector`; тестовые fixture загружают `vector`/`pgcrypto` в изолированный PostgreSQL/WASM и применяют настоящий миграционный ledger. Системный pgvector и `DATABASE_URL` для этих тестов не требуются. Это проверка схемы и SQL, а не полноценная проверка отдельного native PostgreSQL, сетевого доступа и production deployment.

Если нужен работающий сервер, используйте существующий `deploy/docker/docker-compose.yml`: сервис `db` основан на образе `pgvector/pgvector:pg16`, затем отдельно выполняется migration job и стартуют web/worker. Для подключения локальных инструментов к PostgreSQL можно запустить временный контейнер с портом только на loopback:

```powershell
docker run --name chronicle-pgvector-dev -e POSTGRES_USER=chronicle -e POSTGRES_PASSWORD=chronicle_dev -e POSTGRES_DB=chronicle -p 127.0.0.1:5434:5432 -d pgvector/pgvector:pg16
$env:DATABASE_URL = 'postgresql://chronicle:chronicle_dev@127.0.0.1:5434/chronicle'
npm run migrate
```

Дождитесь готовности контейнера (`docker exec chronicle-pgvector-dev pg_isready -U chronicle -d chronicle`) перед миграцией. Контейнер в примере временный, пароль только для локальной тестовой БД; не используйте его для пользовательских данных. После работы остановите его через `docker stop chronicle-pgvector-dev` и `docker rm chronicle-pgvector-dev`.

Если Docker недоступен, для unit/SQL-проверок достаточно PGlite. Для полного запуска нужен PostgreSQL той же основной версии с установленным pgvector/pgcrypto либо совместимый управляемый сервис. Копирование исходников расширения в репозиторий само по себе не решает задачу: PostgreSQL загружает скомпилированные файлы для конкретной ОС, архитектуры и версии сервера; их нужно собирать и устанавливать в каталог сервера. Поддержка этих бинарников в репозитории добавила бы матрицу сборок и обновлений без пользы для уже работающих PGlite/контейнерных проверок.

Если позднее потребуется режим без pgvector, это отдельная проектная задача: явный backend, новые append-only миграции, проверка совместимости старых БД и качества retrieval. Локальное отсутствие расширения не является поводом тихо включать такой режим.
