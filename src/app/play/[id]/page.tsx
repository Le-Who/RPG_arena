import { PlayRoom } from "@/components/play-room";
export default async function PlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlayRoom key={id} sessionId={id} />;
}
