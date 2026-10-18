import productInfo from "./product-info.json";

/** Product status is shared by server diagnostics, browser copy and documentation.
 * Build identity and persisted format versions have separate contracts. */
export const PRODUCT_INFO = productInfo;
export const PRODUCT_REVIEWED_LABEL = new Intl.DateTimeFormat("ru", {
  day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
}).format(new Date(`${productInfo.reviewedOn}T00:00:00Z`)).replace(/ г\.$/, "");
