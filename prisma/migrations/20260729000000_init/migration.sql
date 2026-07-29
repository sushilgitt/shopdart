-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'BASIC', 'PREMIUM', 'ELITE');

-- CreateEnum
CREATE TYPE "VideoSource" AS ENUM ('UPLOAD', 'INSTAGRAM', 'YOUTUBE', 'FACEBOOK');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('PENDING', 'UPLOADING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "WidgetLayout" AS ENUM ('GALLERY', 'CAROUSEL', 'STORIES', 'FLOATING', 'PRODUCT_PAGE', 'POPUP');

-- CreateEnum
CREATE TYPE "WidgetStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "PlacementTarget" AS ENUM ('HOME', 'PRODUCT', 'COLLECTION', 'CART', 'ALL_PAGES', 'CUSTOM');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('IMPRESSION', 'VIEW_START', 'VIEW_COMPLETE', 'PRODUCT_CLICK', 'ADD_TO_CART', 'CHECKOUT_STARTED', 'PURCHASE');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "currencyCode" TEXT,
    "countryCode" TEXT,
    "timezone" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "onboardedAt" TIMESTAMP(3),
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "planUpdatedAt" TIMESTAMP(3),
    "billingGid" TEXT,
    "igUserId" TEXT,
    "igUsername" TEXT,
    "igAccessToken" TEXT,
    "igTokenExpiresAt" TIMESTAMP(3),
    "igLastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "source" "VideoSource" NOT NULL DEFAULT 'UPLOAD',
    "sourceRef" TEXT,
    "sourceUrl" TEXT,
    "title" TEXT,
    "caption" TEXT,
    "bunnyVideoId" TEXT,
    "status" "VideoStatus" NOT NULL DEFAULT 'PENDING',
    "posterUrl" TEXT,
    "hlsUrl" TEXT,
    "mp4Url" TEXT,
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "sizeBytes" BIGINT,
    "errorMessage" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductTag" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "variantGid" TEXT,
    "handle" TEXT,
    "title" TEXT,
    "imageUrl" TEXT,
    "priceAmount" DECIMAL(12,2),
    "currencyCode" TEXT,
    "startSec" DOUBLE PRECISION DEFAULT 0,
    "endSec" DOUBLE PRECISION,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Widget" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "layout" "WidgetLayout" NOT NULL,
    "status" "WidgetStatus" NOT NULL DEFAULT 'DRAFT',
    "config" JSONB NOT NULL DEFAULT '{}',
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Widget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetVideo" (
    "widgetId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WidgetVideo_pkey" PRIMARY KEY ("widgetId","videoId")
);

-- CreateTable
CREATE TABLE "Placement" (
    "id" TEXT NOT NULL,
    "widgetId" TEXT NOT NULL,
    "target" "PlacementTarget" NOT NULL,
    "targetRef" TEXT,
    "pathPattern" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Placement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "videoId" TEXT,
    "widgetId" TEXT,
    "type" "EventType" NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "productGid" TEXT,
    "orderGid" TEXT,
    "value" DECIMAL(12,2),
    "currencyCode" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "addToCarts" INTEGER NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "capReachedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "Shop_uninstalledAt_idx" ON "Shop"("uninstalledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Video_bunnyVideoId_key" ON "Video"("bunnyVideoId");

-- CreateIndex
CREATE INDEX "Video_shopId_status_idx" ON "Video"("shopId", "status");

-- CreateIndex
CREATE INDEX "Video_shopId_createdAt_idx" ON "Video"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Video_shopId_source_sourceRef_key" ON "Video"("shopId", "source", "sourceRef");

-- CreateIndex
CREATE INDEX "ProductTag_videoId_position_idx" ON "ProductTag"("videoId", "position");

-- CreateIndex
CREATE INDEX "ProductTag_productGid_idx" ON "ProductTag"("productGid");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTag_videoId_productGid_key" ON "ProductTag"("videoId", "productGid");

-- CreateIndex
CREATE INDEX "Widget_shopId_status_idx" ON "Widget"("shopId", "status");

-- CreateIndex
CREATE INDEX "WidgetVideo_widgetId_position_idx" ON "WidgetVideo"("widgetId", "position");

-- CreateIndex
CREATE INDEX "Placement_widgetId_idx" ON "Placement"("widgetId");

-- CreateIndex
CREATE INDEX "Placement_target_targetRef_idx" ON "Placement"("target", "targetRef");

-- CreateIndex
CREATE INDEX "VideoEvent_shopId_occurredAt_idx" ON "VideoEvent"("shopId", "occurredAt");

-- CreateIndex
CREATE INDEX "VideoEvent_videoId_type_idx" ON "VideoEvent"("videoId", "type");

-- CreateIndex
CREATE INDEX "VideoEvent_widgetId_type_idx" ON "VideoEvent"("widgetId", "type");

-- CreateIndex
CREATE INDEX "VideoEvent_sessionKey_idx" ON "VideoEvent"("sessionKey");

-- CreateIndex
CREATE UNIQUE INDEX "VideoEvent_orderGid_videoId_type_key" ON "VideoEvent"("orderGid", "videoId", "type");

-- CreateIndex
CREATE INDEX "UsageCounter_period_idx" ON "UsageCounter"("period");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_shopId_period_key" ON "UsageCounter"("shopId", "period");

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductTag" ADD CONSTRAINT "ProductTag_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Widget" ADD CONSTRAINT "Widget_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetVideo" ADD CONSTRAINT "WidgetVideo_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "Widget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetVideo" ADD CONSTRAINT "WidgetVideo_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "Widget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoEvent" ADD CONSTRAINT "VideoEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoEvent" ADD CONSTRAINT "VideoEvent_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoEvent" ADD CONSTRAINT "VideoEvent_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "Widget"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

