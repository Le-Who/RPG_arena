import { notFound } from "next/navigation";
import { currentIdentity } from "@/lib/identity";
import { HttpError } from "@/lib/http";
import { VisualModelSettings } from "@/components/visual-model-settings";

export default async function VisualSettingsPage() {
  const identity = await currentIdentity().catch(error => { if (error instanceof HttpError && error.status === 401) return null; throw error; });
  if (!identity?.isAdmin) notFound();
  return <VisualModelSettings />;
}
