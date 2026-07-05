// Vercel serverless function — returns Supabase config to the browser.
// Reads env vars set in the Vercel project dashboard.
export default function handler(req, res) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "";

  if (!url || !key) {
    return res.status(503).json({ error: "Supabase env vars not configured" });
  }

  // Cache for 5 min — these values never change at runtime
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate");
  res.json({ url, key });
}
