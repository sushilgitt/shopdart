import {
  PlacementTarget,
  WidgetLayout,
  WidgetStatus,
  type Prisma,
  type Widget,
} from "@prisma/client";
import prisma from "../db.server";
import { defaultConfig, parseConfig, type WidgetConfig } from "./widget-config";

export async function listWidgets(shopId: string) {
  return prisma.widget.findMany({
    where: { shopId },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { videos: true, placements: true } } },
  });
}

export async function getWidget(shopId: string, widgetId: string) {
  return prisma.widget.findFirst({
    where: { id: widgetId, shopId },
    include: {
      placements: true,
      videos: {
        orderBy: { position: "asc" },
        include: {
          video: { include: { _count: { select: { tags: true } } } },
        },
      },
    },
  });
}

export async function createWidget(
  shopId: string,
  name: string,
  layout: WidgetLayout,
): Promise<Widget> {
  return prisma.widget.create({
    data: {
      shopId,
      name: name.trim() || "Untitled widget",
      layout,
      config: defaultConfig(layout) as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * Persists presentation settings.
 *
 * `configVersion` is incremented on every save. That number is the CDN cache
 * key for the published payload, so skipping the bump would leave merchants
 * looking at their old settings on the storefront with no way to force a
 * refresh.
 */
export async function updateWidgetConfig(
  shopId: string,
  widgetId: string,
  patch: Partial<WidgetConfig> & { name?: string },
): Promise<Widget | null> {
  const existing = await prisma.widget.findFirst({
    where: { id: widgetId, shopId },
  });
  if (!existing) return null;

  const merged = parseConfig(
    { ...(existing.config as object), ...patch },
    existing.layout,
  );

  return prisma.widget.update({
    where: { id: existing.id },
    data: {
      ...(patch.name !== undefined
        ? { name: patch.name.trim() || existing.name }
        : {}),
      config: merged as unknown as Prisma.InputJsonValue,
      configVersion: { increment: 1 },
    },
  });
}

export async function setWidgetStatus(
  shopId: string,
  widgetId: string,
  status: WidgetStatus,
): Promise<Widget | null> {
  const existing = await prisma.widget.findFirst({
    where: { id: widgetId, shopId },
  });
  if (!existing) return null;

  return prisma.widget.update({
    where: { id: existing.id },
    data: {
      status,
      publishedAt: status === WidgetStatus.PUBLISHED ? new Date() : null,
      configVersion: { increment: 1 },
    },
  });
}

export async function deleteWidget(
  shopId: string,
  widgetId: string,
): Promise<void> {
  await prisma.widget.deleteMany({ where: { id: widgetId, shopId } });
}

/**
 * Replaces the widget's video list, preserving the given order.
 *
 * Only READY videos are accepted: adding one still encoding would publish a
 * broken player to the storefront.
 */
export async function setWidgetVideos(
  shopId: string,
  widgetId: string,
  videoIds: string[],
): Promise<void> {
  const widget = await prisma.widget.findFirst({
    where: { id: widgetId, shopId },
  });
  if (!widget) return;

  const playable = await prisma.video.findMany({
    where: {
      id: { in: videoIds },
      shopId,
      archivedAt: null,
      status: "READY",
    },
    select: { id: true },
  });
  const allowed = new Set(playable.map((video) => video.id));
  const ordered = videoIds.filter((id) => allowed.has(id));

  await prisma.$transaction([
    prisma.widgetVideo.deleteMany({ where: { widgetId } }),
    prisma.widgetVideo.createMany({
      data: ordered.map((videoId, index) => ({
        widgetId,
        videoId,
        position: index,
      })),
    }),
    prisma.widget.update({
      where: { id: widgetId },
      data: { configVersion: { increment: 1 } },
    }),
  ]);
}

export async function setPlacements(
  shopId: string,
  widgetId: string,
  placements: { target: PlacementTarget; targetRef?: string | null }[],
): Promise<void> {
  const widget = await prisma.widget.findFirst({
    where: { id: widgetId, shopId },
  });
  if (!widget) return;

  await prisma.$transaction([
    prisma.placement.deleteMany({ where: { widgetId } }),
    prisma.placement.createMany({
      data: placements.map((placement) => ({
        widgetId,
        target: placement.target,
        targetRef: placement.targetRef || null,
      })),
    }),
    prisma.widget.update({
      where: { id: widgetId },
      data: { configVersion: { increment: 1 } },
    }),
  ]);
}

