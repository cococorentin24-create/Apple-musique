// ═══════════════════════════════════════════════════════════════
// Musico — drive-token
//
// Appelée par le frontend (utilisateur connecté) pour obtenir un access
// token Google Drive temporaire à usage immédiat. Le refresh_token ne
// quitte jamais le serveur : cette fonction le lit, l'échange auprès de
// Google, et ne renvoie que l'access_token de courte durée.
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthedUser, HttpError, corsHeaders, jsonResponse } from "../_shared/auth-user.ts";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }

  try {
    if (req.method !== "POST") {
      throw new HttpError(405, "method_not_allowed");
    }

    // 1. Identifier l'utilisateur Musico côté serveur à partir de son JWT.
    const user = await getAuthedUser(req);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // 2. Chercher UNIQUEMENT la ligne appartenant à cet utilisateur.
    const { data: tokenRow, error: fetchError } = await supabaseAdmin
      .from("google_drive_tokens")
      .select("refresh_token, google_email")
      .eq("user_id", user.id)
      .maybeSingle();

    if (fetchError) {
      console.error("drive-token: fetch failed", fetchError.message);
      return jsonResponse({ error: "internal_error" }, 500, origin);
    }

    if (!tokenRow) {
      return jsonResponse({ error: "not_connected" }, 404, origin);
    }

    // 3. Échanger le refresh_token contre un access_token frais.
    const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

    const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        refresh_token: tokenRow.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    const tokenJson = await tokenRes.json();

    if (!tokenRes.ok || tokenJson.error) {
      // invalid_grant = l'utilisateur a révoqué l'accès depuis son compte
      // Google, ou le refresh_token n'est plus valide pour une autre
      // raison. Le frontend doit alors proposer de reconnecter Google.
      if (tokenJson.error === "invalid_grant") {
        console.warn("drive-token: invalid_grant for user", user.id);
        // On supprime la ligne devenue inutilisable pour éviter de la
        // retenter indéfiniment et pour refléter l'état réel (déconnecté).
        await supabaseAdmin
          .from("google_drive_tokens")
          .delete()
          .eq("user_id", user.id);
        return jsonResponse({ error: "reauth_required" }, 401, origin);
      }
      console.error("drive-token: refresh failed", tokenJson.error);
      return jsonResponse({ error: "token_refresh_failed" }, 502, origin);
    }

    // 4. Ne renvoyer QUE ce dont le frontend a besoin. Jamais le
    //    refresh_token.
    return jsonResponse(
      {
        access_token: tokenJson.access_token,
        expires_in: tokenJson.expires_in,
        google_email: tokenRow.google_email,
      },
      200,
      origin,
    );
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.code }, err.status, origin);
    }
    console.error("drive-token unexpected error", err);
    return jsonResponse({ error: "internal_error" }, 500, origin);
  }
});
