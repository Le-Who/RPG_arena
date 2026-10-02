import type { Metadata } from "next";
import { DesignCatalog } from "@/components/design-catalog";

export const metadata: Metadata = { title: "Дизайн-система" };

export default function DesignPage() {
  return <DesignCatalog />;
}
