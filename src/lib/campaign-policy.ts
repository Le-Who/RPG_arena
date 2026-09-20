export type CampaignAccess = "read" | "owner";
export function canAccessCampaign(campaign: { ownerId: string | null; visibility: string }, profileId: string, access: CampaignAccess): boolean {
  if (!campaign.ownerId) return false;
  return campaign.ownerId === profileId || (access === "read" && campaign.visibility === "public");
}
