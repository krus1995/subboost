import {
  deleteSubscriptionResponse,
  getSubscriptionResponse,
  updateSubscriptionResponse,
} from "@local/lib/subscription-route-handlers";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  return getSubscriptionResponse(id, new URL(request.url).searchParams.get("editTransport") === "compact-v1");
}

export async function PUT(request: Request, { params }: RouteContext) {
  const { id } = await params;
  return updateSubscriptionResponse(request, id);
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  return deleteSubscriptionResponse(id);
}
