import { notFound } from "next/navigation";
import { Dashboard, type Section } from "@/components/dashboard";
const sections = ["campaigns", "worlds", "characters", "memory", "journal"];
export function generateStaticParams() { return sections.map((section) => ({ section })); }
export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!sections.includes(section)) notFound();
  return <Dashboard section={section as Section} />;
}
