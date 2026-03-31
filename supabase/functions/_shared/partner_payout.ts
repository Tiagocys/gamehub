function safeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

export function isMissingPartnerPayoutTableError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  const message = String(err.message || "").toLowerCase();
  return message.includes("partner_payout_events");
}

export function isMissingWalletTablesError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  const message = String(err.message || "").toLowerCase();
  return message.includes("wallets") || message.includes("wallet_events") || message.includes("highlight_daily_metrics");
}

function isMissingAdminBeneficiaryColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("admin_beneficiary_id");
}

export async function getPartnerPayoutSummary(supabase: any, userId: string) {
  let serverRows: Array<{ id: string; owner_id: string | null; admin_beneficiary_id: string | null }> = [];
  let { data: servers, error: serverErr } = await supabase
    .from("servers")
    .select("id,owner_id,admin_beneficiary_id")
    .or(`owner_id.eq.${userId},admin_beneficiary_id.eq.${userId}`);

  if (isMissingAdminBeneficiaryColumnError(serverErr)) {
    const fallback = await supabase
      .from("servers")
      .select("id,owner_id")
      .eq("owner_id", userId);
    servers = Array.isArray(fallback.data)
      ? fallback.data.map((row: any) => ({ ...row, admin_beneficiary_id: null }))
      : [];
    serverErr = fallback.error;
  }

  if (serverErr) throw serverErr;
  serverRows = Array.isArray(servers) ? servers : [];

  if (serverRows.length === 0) {
    return {
      unsupported: false,
      totalExpected: 0,
      availableAmount: 0,
      pendingAmount: 0,
      count: 0,
      method: "wallet-consume-by-listing-v3",
      withdrawRequest: null,
    };
  }

  const serverById = new Map(serverRows.map((row) => [row.id, row]));
  const serverIds = serverRows.map((row) => row.id);

  const { data: listingRows, error: listingErr } = await supabase
    .from("listings")
    .select("id,server_id,highlight_status")
    .in("server_id", serverIds);
  if (listingErr) throw listingErr;

  const listings = Array.isArray(listingRows) ? listingRows : [];
  const listingById = new Map(
    listings
      .filter((row: any) => row?.id && row?.server_id)
      .map((row: any) => [String(row.id), { server_id: String(row.server_id), highlight_status: String(row.highlight_status || "") }]),
  );
  const listingIds = Array.from(listingById.keys());

  let totalExpectedCentsFromEvents = 0;
  let pendingCentsFromEvents = 0;

  const { data: payoutRows, error: payoutErr } = await supabase
    .from("partner_payout_events")
    .select("expected_net_amount,refunded_net_amount,payout_status")
    .eq("owner_user_id", userId)
    .in("server_id", serverIds)
    .in("payout_status", ["pending", "eligible"]);
  if (payoutErr && !isMissingPartnerPayoutTableError(payoutErr)) {
    throw payoutErr;
  }

  (Array.isArray(payoutRows) ? payoutRows : []).forEach((row: any) => {
    const expectedNetCents = Math.max(0, Math.round(Number(row?.expected_net_amount || 0) * 100));
    const refundedNetCents = Math.max(0, Math.round(Number(row?.refunded_net_amount || 0) * 100));
    const outstandingCents = Math.max(0, expectedNetCents - refundedNetCents);
    if (outstandingCents <= 0) return;
    totalExpectedCentsFromEvents += outstandingCents;
    if (String(row?.payout_status || "").toLowerCase() === "pending") {
      pendingCentsFromEvents += outstandingCents;
    }
  });

  if (listingIds.length === 0) {
    return {
      unsupported: false,
      totalExpected: Number((totalExpectedCentsFromEvents / 100).toFixed(2)),
      availableAmount: 0,
      pendingAmount: Number((pendingCentsFromEvents / 100).toFixed(2)),
      count: 0,
      method: "wallet-consume-by-listing-v3",
      withdrawRequest: null,
    };
  }

  const { data: metricsRows, error: metricsErr } = await supabase
    .from("highlight_daily_metrics")
    .select("listing_id,charged_cents,stat_date")
    .in("listing_id", listingIds)
    .order("stat_date", { ascending: false });
  if (isMissingWalletTablesError(metricsErr)) {
    return {
      unsupported: true,
      totalExpected: 0,
      availableAmount: 0,
      pendingAmount: 0,
      count: 0,
      method: "wallet-consume-by-listing-v3",
      withdrawRequest: null,
    };
  }
  if (metricsErr) throw metricsErr;

  let grossAvailableCents = 0;
  const activeHighlightedListingIds = new Set(
    listings
      .filter((row: any) => String(row?.highlight_status || "").toLowerCase() === "active")
      .map((row: any) => String(row.id)),
  );

  (Array.isArray(metricsRows) ? metricsRows : []).forEach((row: any) => {
    const listingId = String(row?.listing_id || "").trim();
    if (!listingId) return;
    const listing = listingById.get(listingId);
    if (!listing) return;
    const server = serverById.get(listing.server_id);
    if (!server) return;

    let shareRatio = 0;
    if (server.owner_id === userId) {
      shareRatio = 0.25;
    } else if (server.admin_beneficiary_id === userId) {
      shareRatio = 0.25;
    }
    if (shareRatio <= 0) return;

    const consumedCents = safeInt(row?.charged_cents, 0);
    if (consumedCents <= 0) return;

    const partnerCents = Math.round(consumedCents * shareRatio);
    if (partnerCents <= 0) return;

    grossAvailableCents += partnerCents;
  });

  const pendingListingCount = activeHighlightedListingIds.size;

  const { data: requestRows, error: requestErr } = await supabase
    .from("partner_withdraw_requests")
    .select("id,requested_amount,status,country_code,target_currency,created_at,partner_payout_account_id")
    .eq("user_id", userId)
    .in("status", ["pending", "approved", "paid"])
    .order("created_at", { ascending: false })
    .limit(50);
  if (requestErr && requestErr.code !== "42P01") {
    throw requestErr;
  }
  const withdrawRequests = Array.isArray(requestRows) ? requestRows : [];
  const withdrawRequest = withdrawRequests.length > 0
    ? withdrawRequests.find((row: any) => ["pending", "approved"].includes(String(row?.status || "").toLowerCase()))
      || withdrawRequests[0]
    : null;

  let lockedCents = 0;
  let paidCents = 0;
  withdrawRequests.forEach((row: any) => {
    const amountCents = Math.max(0, Math.round(Number(row?.requested_amount || 0) * 100));
    if (amountCents <= 0) return;
    const status = String(row?.status || "").toLowerCase();
    if (status === "pending" || status === "approved") {
      lockedCents += amountCents;
    } else if (status === "paid") {
      paidCents += amountCents;
    }
  });

  const availableCents = Math.max(0, grossAvailableCents - lockedCents - paidCents);
  const totalExpectedCents = Math.max(totalExpectedCentsFromEvents, grossAvailableCents);
  const pendingAmountCents = Math.max(pendingCentsFromEvents, lockedCents);

  return {
    unsupported: false,
    totalExpected: Number((totalExpectedCents / 100).toFixed(2)),
    availableAmount: Number((availableCents / 100).toFixed(2)),
    pendingAmount: Number((pendingAmountCents / 100).toFixed(2)),
    count: pendingListingCount,
    method: "wallet-consume-by-listing-v3",
    withdrawRequest,
  };
}
