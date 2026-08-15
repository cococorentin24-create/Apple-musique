// ═══════════════════════════════════════════════════════════════
// Musico — helper partagé : identifier l'utilisateur Musico côté serveur
// à partir de son JWT Supabase (jamais depuis un paramètre envoyé par
// le navigateur).
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface AuthedUser {
  id: string;
  email: string | null;
}

/**
 * Vérifie le JWT Supabase présent dans l'en-tête Authorization et retourne
 * l'utilisateur Musico correspondant. Lève une erreur si le token est
 * absent, invalide ou expiré.
 *
 * Utilise le rôle SERVICE_ROLE pour interroger auth.getUser(), ce qui est
 * la méthode recommandée par Supabase pour valider un JWT côté Edge
 * Function sans dépendre de la clé anon.
 */
export async function getAuthedUser(req: Request): Promise<AuthedUser> {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    throw new HttpError(401, "missing_authorization_header");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data?.user) {
    throw new HttpError(401, "invalid_or_expired_token");
  }

  return { id: data.user.id, email: data.user.email ?? null };
}

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** En-têtes CORS communs — Musico est servi depuis une seule origine connue. */
export function corsHeaders(origin: string | null): Record<string, string> {
  const allowedOrigin = "https://musico-3us.pages.dev";
  return {
    "Access-Control-Allow-Origin": origin === allowedOrigin ? allowedOrigin : allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

export function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}
