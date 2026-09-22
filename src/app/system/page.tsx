import { SystemPanel } from "@/components/system-panel";
import { currentIdentity } from "@/lib/identity";
import { notFound } from "next/navigation";
import { HttpError } from "@/lib/http";
export default async function SystemPage() {
  const identity = await currentIdentity().catch(error => { if (error instanceof HttpError && error.status === 401) return null; throw error; });
  if (!identity?.isAdmin) notFound();
  return <SystemPanel />;
}
