import type { Context } from "@netlify/functions";

const NEWS_FEED_URL = "https://rss.app/feeds/v1.1/5Wdnismo41isPtyA.json";

export default async (_req: Request, _context: Context) => {
  let items: unknown[] = [];

  try {
    const res = await fetch(NEWS_FEED_URL, {
      headers: { "User-Agent": "PlayerPropsApp/1.0" },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      throw new Error(`RSS feed responded with ${res.status}`);
    }

    const raw = (await res.json()) as { items?: Record<string, unknown>[] };

    items = (raw.items ?? []).slice(0, 30).map((item) => ({
      id: item["id"] ?? "",
      text: item["content_text"] || item["title"] || "",
      url: item["url"] ?? "",
      image: item["image"] ?? null,
      published_at: item["date_published"] ?? "",
      // Player-matching is done client-side (app.js has the prop list);
      // the Netlify function just proxies the raw feed items.
      players: [],
    }));
  } catch (err) {
    console.error("[news] feed fetch failed —", err);
    // Return an empty list rather than a 5xx so the ticker degrades silently.
  }

  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};
