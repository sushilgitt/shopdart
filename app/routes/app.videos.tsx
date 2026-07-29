import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../lib/shop.server";
import { planFor } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const videos = await prisma.video.findMany({
    where: { shopId: shop.id, archivedAt: null },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { _count: { select: { tags: true } } },
  });

  return {
    videos: videos.map((video) => ({
      id: video.id,
      title: video.title ?? "Untitled",
      source: video.source,
      status: video.status,
      durationSec: video.durationSec,
      posterUrl: video.posterUrl,
      tagCount: video._count.tags,
    })),
    instagramConnected: Boolean(shop.igUserId),
    igUsername: shop.igUsername,
    limit: planFor(shop.plan).videos,
  };
};

export default function Videos() {
  const { videos, instagramConnected, igUsername, limit } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Videos">
      <s-button slot="primary-action" disabled>
        Upload video
      </s-button>

      {videos.length === 0 ? (
        <s-section heading="No videos yet">
          <s-paragraph>
            Shopdart plays videos you own — reels from your own Instagram
            Business account, or files you upload directly. Both are stored and
            streamed through Bunny Stream so playback stays fast anywhere in the
            world.
          </s-paragraph>
          <s-paragraph>
            <s-text color="subdued">
              You can add up to {limit.toLocaleString()} videos on your current
              plan.
            </s-text>
          </s-paragraph>
        </s-section>
      ) : (
        <s-section heading={`${videos.length} video${videos.length === 1 ? "" : "s"}`}>
          <s-stack direction="block" gap="base">
            {videos.map((video) => (
              <s-box
                key={video.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack
                  direction="inline"
                  gap="base"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-text type="strong">{video.title}</s-text>
                    <s-text color="subdued">
                      {video.source} · {video.status} · {video.tagCount} product
                      {video.tagCount === 1 ? "" : "s"} tagged
                    </s-text>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Instagram">
        {instagramConnected ? (
          <s-paragraph>
            Connected as <s-text type="strong">@{igUsername}</s-text>
          </s-paragraph>
        ) : (
          <>
            <s-paragraph>
              Connect your Instagram Business or Creator account to sync your own
              reels into Shopdart.
            </s-paragraph>
            <s-button disabled variant="secondary">
              Connect Instagram
            </s-button>
          </>
        )}
      </s-section>

      <s-section slot="aside" heading="Coming in this phase">
        <s-paragraph>
          <s-text color="subdued">
            Upload and Instagram sync arrive with the Bunny Stream pipeline.
            The library, plan limits and product tagging schema are already in
            place behind this screen.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
