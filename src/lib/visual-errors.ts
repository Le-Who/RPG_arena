/** Safe public copy; provider response bodies can contain credentials or request data. */
export const OPENAI_VISUAL_ERRORS: Readonly<Record<string, string>> = {
  OPENAI_KEY_REQUIRED: "Добавьте API-ключ OpenAI в настройках подключений.",
  OPENAI_AUTH_FAILED: "OpenAI отклонил API-ключ. Замените его в настройках подключений.",
  OPENAI_ACCESS_DENIED: "Нет доступа к генерации изображений OpenAI. Проверьте права ключа и доступ проекта к модели.",
  OPENAI_RATE_LIMITED: "OpenAI сообщил о лимите запросов или квоте. Проверьте лимиты и баланс API-проекта, затем повторите.",
  OPENAI_REQUEST_REJECTED: "OpenAI отклонил запрос изображения. Проверьте выбранную модель или попробуйте другое описание.",
  OPENAI_MODEL_UNAVAILABLE: "Выбранная модель OpenAI недоступна. Выберите другую модель иллюстраций в настройках.",
};

export function visualErrorMessage(code: string | null | undefined): string {
  return code && Object.hasOwn(OPENAI_VISUAL_ERRORS, code) ? OPENAI_VISUAL_ERRORS[code] : "Провайдер не вернул изображение. Попробуйте повторить генерацию.";
}
