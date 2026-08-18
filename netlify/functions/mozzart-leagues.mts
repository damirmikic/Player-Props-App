import type { Context } from "@netlify/functions";
import { loadMozzartPlayerPropLeagues } from "./lib/mozzart.js";

export default async (req: Request, context: Context) => {
  const payload = await loadMozzartPlayerPropLeagues();

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};

