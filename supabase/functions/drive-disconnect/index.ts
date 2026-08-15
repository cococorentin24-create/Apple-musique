// ═══════════════════════════════════════════════════════════════
// Musico — drive-disconnect
//
// Révoque l'autorisation Google (best effort) et supprime UNIQUEMENT la
// ligne google_drive_tokens de l'utilisateur authentifié — jamais celle
// d'un autre utilisateur, car la ligne ciblée est toujours dérivée du
// JWT vérifié côté serveur, jamais d'un paramètre client.
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthedUser, HttpError, corsHeaders, jsonResponse } from "../_shared/auth-user.ts";

const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }

  try {
    if (req.method !== "POST") {
      throw new HttpError(405, "method_not_allowed");
    }

    const user = await getAuthedUser(req);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data: tokenRow, error: fetchError } = await supabaseAdmin
      .from("google_drive_tokens")
      .select("refresh_token")
      .eq("user_id", user.id)
      .maybeSingle();

    if (fetchError) {
      console.error("drive-disconnect: fetch failed", fetchError.message);
      return jsonResponse({ error: "internal_error" }, 500, origin);
    }

    if (!tokenRow) {
      // Déjà déconnecté : idempotent, pas une erreur.
      return jsonResponse({ disconnected: true, already: true }, 200, origin);
    }

    // Révocation côté Google — best effort. Un échec de révocation ne doit
    // pas empêcher la suppression locale : l'utilisateur s'attend à ce que
    // "déconnecter" fonctionne côté Musico même si Google répond mal.
    try {
      await fetch(GOOGLE_REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokenRow.refresh_token }),
      });
    } catch (err) {
      console.warn("drive-disconnect: Google revoke call failed (non-blocking)", err);
    }

    const { error: deleteError } = await supabaseAdmin
      .from("google_drive_tokens")
      .delete()
      .eq("user_id", user.id);

    if (deleteError) {
      console.error("drive-disconnect: delete failed", deleteError.message);
      return jsonResponse({ error: "internal_error" }, 500, origin);
    }

    return jsonResponse({ disconnected: true, already: false }, 200, origin);
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.code }, err.status, origin);
    }
    console.error("drive-disconnect unexpected error", err);
    return jsonResponse({ error: "internal_error" }, 500, origin);
  }
});
