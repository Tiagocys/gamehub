export class RateLimitError extends Error {
  status: number;
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
    this.status = 429;
  }
}

function floorToBucket(date: Date, bucketSeconds: number) {
  const bucketMs = Math.max(1, bucketSeconds) * 1000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

export async function enforceUserRateLimit(
  supabase: any,
  userId: string,
  action: string,
  options: {
    maxCount: number;
    windowSeconds: number;
    bucketSeconds?: number;
    message: string;
  },
) {
  const now = new Date();
  const bucketSeconds = Math.max(60, Number(options.bucketSeconds || 60));
  const bucketStart = floorToBucket(now, bucketSeconds).toISOString();
  const windowStart = new Date(now.getTime() - Math.max(1, options.windowSeconds) * 1000).toISOString();

  const { data: rows, error: fetchErr } = await supabase
    .from("function_rate_limits")
    .select("count,bucket_start")
    .eq("user_id", userId)
    .eq("action", action)
    .gte("bucket_start", windowStart);
  if (fetchErr) throw fetchErr;

  const total = (rows || []).reduce((sum: number, row: any) => sum + Number(row?.count || 0), 0);
  if (total >= options.maxCount) {
    throw new RateLimitError(options.message);
  }

  const { error: incrementErr } = await supabase.rpc("increment_function_rate_limit", {
    p_user_id: userId,
    p_action: action,
    p_bucket_start: bucketStart,
  });
  if (incrementErr) throw incrementErr;
}
