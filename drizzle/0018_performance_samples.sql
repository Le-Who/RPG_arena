-- PERF-1 / PERF-2 / PERF-4 (2.10): обезличенные замеры реального браузера — Web Vitals,
-- сетевые тайминги первого экрана и воспринимаемая задержка хода. Нет owner/session/IP и URL
-- с идентификаторами: только метрика, шаблон маршрута, значение, оценка и класс устройства.
-- Хранение ограничено приложением (14 дней, верхний предел строк); таблица аддитивна.
CREATE TABLE IF NOT EXISTS "performance_samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"metric" text NOT NULL,
	"route" text NOT NULL,
	"value" double precision NOT NULL,
	"rating" text DEFAULT 'unknown' NOT NULL,
	"device" text DEFAULT 'unknown' NOT NULL,
	"navigation_type" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performance_samples_metric_check" CHECK (char_length("metric") BETWEEN 2 AND 40),
	CONSTRAINT "performance_samples_route_check" CHECK (char_length("route") BETWEEN 1 AND 80),
	CONSTRAINT "performance_samples_value_check" CHECK ("value" >= 0 AND "value" <= 600000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_samples_metric_created_idx" ON "performance_samples" USING btree ("metric", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_samples_created_idx" ON "performance_samples" USING btree ("created_at");
