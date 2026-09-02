import { Plan } from "@prisma/client";

/**
 * Plan definitions. Prices are USD and must stay in sync with the
 * AppSubscription line items created in app/lib/billing.server.ts.
 *
 * `views` is the metered resource: one VIEW_START event per deduped session
 * per video. Impressions are deliberately unmetered — merchants should never
 * be charged for a widget simply rendering.
 */
export interface PlanDefinition {
  id: Plan;
  name: string;
  /** USD per month. 0 on the free plan. */
  price: number;
  /** Metered video views per calendar month. */
  views: number;
  /** Maximum videos in the library at once. */
  videos: number;
  trialDays: number;
  watermark: boolean;
  features: string[];
}

export const PLANS: Record<Plan, PlanDefinition> = {
  FREE: {
    id: Plan.FREE,
    name: "Free",
    price: 0,
    views: 100,
    videos: 10,
    trialDays: 0,
    watermark: true,
    features: ["All widget layouts", "Basic analytics", "Unlimited impressions"],
  },
  BASIC: {
    id: Plan.BASIC,
    name: "Basic",
    price: 19,
    views: 3_000,
    videos: 100,
    trialDays: 7,
    watermark: false,
    features: ["Remove DPS watermark", "Instagram sync", "Basic analytics"],
  },
  PREMIUM: {
    id: Plan.PREMIUM,
    name: "Premium",
    price: 39,
    views: 20_000,
    videos: 250,
    trialDays: 7,
    watermark: false,
    features: [
      "Everything in Basic",
      "Revenue attribution per video",
      "Priority support",
    ],
  },
  ELITE: {
    id: Plan.ELITE,
    name: "Elite",
    price: 59,
    views: 50_000,
    videos: 1_000,
    trialDays: 7,
    watermark: false,
    features: [
      "Everything in Premium",
      "Placement-level reporting",
      "Dedicated support",
    ],
  },
};

export const PLAN_ORDER: Plan[] = [
  Plan.FREE,
  Plan.BASIC,
  Plan.PREMIUM,
  Plan.ELITE,
];

export function planFor(plan: Plan): PlanDefinition {
  return PLANS[plan];
}

/** Current billing period key, e.g. "2026-07". Always UTC. */
export function currentPeriod(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}
