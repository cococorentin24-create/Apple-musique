// ═══════════════════════════════════════════════════════════════
// Musico — google-oauth-callback
//
// Reçoit le retour de Google après consentement de l'utilisateur.
// Ne fait JAMAIS confiance à un user_id venant du navigateur : l'identité
// de l'utilisateur Musico est retrouvée en relisant le `state` généré par
// google-oauth-start et enregistré côté serveur à ce moment-là.
//
// Sécurité appliquée ici :
//  - state inconnu / expiré (>10 min) / déjà utilisé  → rejet
//  - state marqué "used" AVANT l'échange du code, pour empêcher le replay
//    même en cas de double-appel concurrent (best effort ; voir note plus bas)
//  - Client Secret Google lu uniquement depuis les secrets Edge Functions
//  - le refresh_token n'est jamais renvoyé au navigateur, uniquement stocké
//    côté serveur dans google_drive_tokens
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const REDIRECT_URI =
  "https://wtjvaaeflasnebxjhxmg.supabase.co/functions/v1/google-oauth-callback";
const MUSICO_APP_URL = "https://musico-3us.pages.dev/";
const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function redirectToApp(status: "success" | "error", detail?: string): Response {
  const url = new URL(MUSICO_APP_URL);
  url.searchParams.set("gdrive", status);
  if (detail) url.searchParams.set("gdrive_reason", detail);
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString() },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Google peut renvoyer une erreur directement (utilisateur qui refuse
  // le consentement, etc.) sans authorization code.
  const googleError = url.searchParams.get("error");
  if (googleError) {
    console.warn("google-oauth-callback: Google returned error", googleError);
    return redirectToApp("error", "google_denied");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return redirectToApp("error", "missing_code_or_state");
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // ── 1. Valider et consommer le state ────────────────────────────
  const { data: stateRow, error: stateError } = await supabaseAdmin
    .from("oauth_states")
    .select("user_id, created_at, used")
    .eq("state", state)
    .maybeSingle();

  if (stateError || !stateRow) {
    console.warn("google-oauth-callback: unknown state");
    return redirectToApp("error", "invalid_state");
  }

  if (stateRow.used) {
    console.warn("google-oauth-callback: state already used (replay attempt?)");
    return redirectToApp("error", "state_already_used");
  }

  const age = Date.now() - new Date(stateRow.created_at).getTime();
  if (age > STATE_MAX_AGE_MS) {
    console.warn("google-oauth-callback: state expired");
    return redirectToApp("error", "state_expired");
  }

  const userId = stateRow.user_id as string;

  // Marquer le state comme utilisé IMMÉDIATEMENT, avant l'échange réseau
  // avec Google, pour réduire au minimum la fenêtre de replay. Un
  // verrou parfait nécessiterait une contrainte atomique
  // (UPDATE ... WHERE used = false RETURNING *) ; on l'utilise ici plutôt
  // qu'un simple update pour se prémunir d'une double-consommation
  // concurrente du même state.
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("oauth_states")
    .update({ used: true })
    .eq("state", state)
    .eq("used", false)
    .select("state")
    .maybeSingle();

  if (claimError || !claimed) {
    console.warn("google-oauth-callback: state claim race lost");
    return redirectToApp("error", "state_already_used");
  }

  // ── 2. Échanger le code contre les tokens Google (côté serveur) ──
  const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

  let tokenJson: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    tokenJson = await tokenRes.json();

    if (!tokenRes.ok || tokenJson.error) {
      console.error("google-oauth-callback: token exchange failed", tokenJson.error);
      return redirectToApp("error", "token_exchange_failed");
    }
  } catch (err) {
    console.error("google-oauth-callback: token exchange network error", err);
    return redirectToApp("error", "token_exchange_network_error");
  }

  if (!tokenJson.refresh_token) {
    // Arrive si l'utilisateur avait déjà autorisé l'app sans que
    // prompt=consent n'ait été respecté, ou en cas de réautorisation
    // rapprochée. google-oauth-start force prompt=consent+access_type=offline
    // justement pour éviter ce cas, mais on le gère quand même proprement.
    console.warn("google-oauth-callback: no refresh_token returned by Google");
    return redirectToApp("error", "no_refresh_token");
  }

  // ── 3. Récupérer l'email Google (best effort, non bloquant) ──────
  let googleEmail: string | null = null;
  try {
    const userInfoRes = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (userInfoRes.ok) {
      const info = await userInfoRes.json();
      googleEmail = info.email ?? null;
    }
  } catch (err) {
    console.warn("google-oauth-callback: userinfo fetch failed (non-blocking)", err);
  }

  // ── 4. Stocker le refresh_token côté serveur, lié au bon utilisateur ─
  // On distingue insert (première connexion) et update (reconnexion) pour
  // ne pas écraser created_at à chaque reconnexion — plus simple et plus
  // sûr qu'un upsert avec valeur par défaut recalculée à chaque fois.
  const { data: existingRow } = await supabaseAdmin
    .from("google_drive_tokens")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  const nowIso = new Date().toISOString();
  const { error: upsertError } = existingRow
    ? await supabaseAdmin
        .from("google_drive_tokens")
        .update({
          refresh_token: tokenJson.refresh_token,
          google_email: googleEmail,
          updated_at: nowIso,
        })
        .eq("user_id", userId)
    : await supabaseAdmin.from("google_drive_tokens").insert({
        user_id: userId,
        refresh_token: tokenJson.refresh_token,
        google_email: googleEmail,
        created_at: nowIso,
        updated_at: nowIso,
      });

  if (upsertError) {
    console.error("google-oauth-callback: token storage failed", upsertError.message);
    return redirectToApp("error", "token_storage_failed");
  }

  // Nettoyage : la ligne oauth_states n'est plus utile une fois consommée.
  await supabaseAdmin.from("oauth_states").delete().eq("state", state);

  return redirectToApp("success");
});
