// ═══════════════════════════════════════════════════════════════
// Musico — google-oauth-start
//
// Appelée par le frontend (utilisateur déjà connecté à Musico) pour
// démarrer le flow "Connecter Google Drive". Génère un `state` opaque
// et imprévisible, l'enregistre en base lié au user_id RÉEL (extrait du
// JWT côté serveur, jamais du frontend), puis renvoie l'URL Google vers
// laquelle le navigateur doit rediriger.
//
// C'est la pièce qui rend le mécanisme state sûr : le lien
// state → user_id est créé ici, sous contrôle serveur, AVANT que
// l'utilisateur ne parte vers Google. Le callback (google-oauth-callback)
// n'aura plus qu'à relire ce lien, jamais à faire confiance à un user_id
// fourni par le navigateur.
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthedUser, HttpError, corsHeaders, jsonResponse } from "../_shared/auth-user.ts";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const REDIRECT_URI =
  "https://wtjvaaeflasnebxjhxmg.supabase.co/functions/v1/google-oauth-callback";

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
    //    Jamais depuis un paramètre du body/query — c'est la seule source
    //    de vérité acceptée.
    const user = await getAuthedUser(req);

    // 2. Générer un state imprévisible (256 bits d'entropie crypto).
    const stateBytes = new Uint8Array(32);
    crypto.getRandomValues(stateBytes);
    const state = Array.from(stateBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // 3. Enregistrer le lien state → user_id en base, côté serveur,
    //    via le rôle service_role (bypass RLS, table sans policy frontend).
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { error: insertError } = await supabaseAdmin
      .from("oauth_states")
      .insert({ state, user_id: user.id });

    if (insertError) {
      console.error("oauth_states insert failed", insertError.message);
      throw new HttpError(500, "state_persist_failed");
    }

    // 4. Construire l'URL Google. access_type=offline + prompt=consent
    //    garantissent qu'un refresh_token est bien renvoyé (Google ne le
    //    renvoie sinon qu'à la toute première autorisation de l'app par
    //    ce compte Google).
    const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });

    const authUrl = `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;

    return jsonResponse({ authUrl }, 200, origin);
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.code }, err.status, origin);
    }
    console.error("google-oauth-start unexpected error", err);
    return jsonResponse({ error: "internal_error" }, 500, origin);
  }
});
