import { serveSubscriptionProfile } from "@local/lib/serve-subscription-profile";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return serveSubscriptionProfile(request, (await params).id, "loon");
}
