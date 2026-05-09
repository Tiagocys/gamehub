export const LISTING_VIEW_COUNT_WINDOW_SECONDS = 30 * 60;
const PAGE_SIZE = 1000;

function safeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function normalizeIds(values: unknown[]) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  ));
}

function getMonthStartIsoDate(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

async function fetchPagedRows<T>(
  queryFactory: (from: number, to: number) => Promise<{ data: T[] | null; error: any }>,
) {
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await queryFactory(from, to);
    if (error) throw error;
    const batch = Array.isArray(data) ? data : [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

export async function getListingViewTotalsByListingIds(
  supabase: any,
  listingIds: string[],
) {
  const normalizedIds = normalizeIds(listingIds);
  const totals = new Map<string, number>();
  normalizedIds.forEach((listingId) => totals.set(listingId, 0));
  if (normalizedIds.length === 0) return totals;

  const rows = await fetchPagedRows<any>((from, to) =>
    supabase
      .from("listing_view_daily_metrics")
      .select("listing_id,views_count")
      .in("listing_id", normalizedIds)
      .order("stat_date", { ascending: false })
      .range(from, to)
  );

  rows.forEach((row) => {
    const listingId = String(row?.listing_id || "").trim();
    if (!listingId) return;
    totals.set(listingId, safeInt(totals.get(listingId), 0) + safeInt(row?.views_count, 0));
  });

  return totals;
}

export async function getPartnerServerAnalytics(
  supabase: any,
  serverIds: string[],
  now = new Date(),
) {
  const normalizedIds = normalizeIds(serverIds);
  const serverAnalytics = new Map<string, {
    totalViews: number;
    monthlyViews: number;
    followersCount: number;
    isEligible: boolean;
  }>();
  normalizedIds.forEach((serverId) => {
    serverAnalytics.set(serverId, {
      totalViews: 0,
      monthlyViews: 0,
      followersCount: 0,
      isEligible: false,
    });
  });

  const monthStart = getMonthStartIsoDate(now);

  if (normalizedIds.length > 0) {
    const metricRows = await fetchPagedRows<any>((from, to) =>
      supabase
        .from("listing_view_daily_metrics")
        .select("server_id,stat_date,views_count")
        .in("server_id", normalizedIds)
        .order("stat_date", { ascending: false })
        .range(from, to)
    );

    metricRows.forEach((row) => {
      const serverId = String(row?.server_id || "").trim();
      if (!serverId || !serverAnalytics.has(serverId)) return;
      const entry = serverAnalytics.get(serverId)!;
      const viewsCount = safeInt(row?.views_count, 0);
      entry.totalViews += viewsCount;
      if (String(row?.stat_date || "") >= monthStart) {
        entry.monthlyViews += viewsCount;
      }
    });
  }

  const followRows = await fetchPagedRows<any>((from, to) =>
    supabase
      .from("server_follows")
      .select("server_id")
      .order("server_id", { ascending: true })
      .range(from, to)
  );

  const globalFollowerCounts = new Map<string, number>();
  followRows.forEach((row) => {
    const serverId = String(row?.server_id || "").trim();
    if (!serverId) return;
    globalFollowerCounts.set(serverId, safeInt(globalFollowerCounts.get(serverId), 0) + 1);
  });

  normalizedIds.forEach((serverId) => {
    const entry = serverAnalytics.get(serverId)!;
    entry.followersCount = safeInt(globalFollowerCounts.get(serverId), 0);
    entry.isEligible = true;
  });

  return {
    followerGoal: null,
    monthlyViewsThreshold: null,
    serverAnalytics,
  };
}
