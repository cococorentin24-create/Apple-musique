-- ═══════════════════════════════════════════════════════════════
-- Musico — Socle OAuth Google Drive
-- Migration : table oauth_states + verrouillage RLS de google_drive_tokens
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Table temporaire pour le paramètre `state` OAuth ─────────
-- Sert UNIQUEMENT à lier de façon sûre un callback Google entrant à
-- l'utilisateur Musico qui a initié le flow, sans jamais faire confiance
-- à un user_id envoyé par le navigateur. Voir google-oauth-start et
-- google-oauth-callback.
create table if not exists public.oauth_states (
  state       text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  used        boolean not null default false
);

-- RLS activée, aucune policy : seules les Edge Functions (rôle service_role,
-- qui bypass RLS) peuvent lire/écrire cette table. Le frontend n'a et
-- n'aura jamais d'accès direct.
alter table public.oauth_states enable row level security;

-- Index pour purger/valider rapidement par âge.
create index if not exists idx_oauth_states_created_at on public.oauth_states (created_at);


-- ─── 2. Verrouillage de google_drive_tokens ───────────────────────
-- La table existe déjà (créée manuellement), on s'assure juste que RLS
-- est bien activée et qu'aucune policy n'autorise le frontend à lire
-- refresh_token. Toutes les opérations passent par les Edge Functions
-- (rôle service_role, qui bypass RLS par design Supabase).
alter table public.google_drive_tokens enable row level security;

-- Aucune policy créée intentionnellement : le rôle "authenticated"
-- (utilisé par le frontend via l'anon/JWT client) n'a donc AUCUN accès
-- direct — ni lecture ni écriture — à cette table. C'est le comportement
-- voulu et documenté dans le prompt original (point 12).


-- ─── 3. Nettoyage périodique des states expirés (optionnel mais recommandé) ─
-- Une state non consommée sous 10 minutes est de toute façon rejetée par
-- google-oauth-callback (voir _shared/oauth-state.ts). Cette fonction permet
-- un ménage périodique si tu configures un cron Supabase (pg_cron), sinon
-- la table reste petite naturellement (peu de lignes, PK courte).
create or replace function public.cleanup_expired_oauth_states()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.oauth_states
  where created_at < now() - interval '10 minutes';
$$;

-- Pour activer le nettoyage automatique (nécessite l'extension pg_cron,
-- à activer manuellement dans Supabase → Database → Extensions) :
--
--   select cron.schedule(
--     'cleanup-oauth-states',
--     '*/15 * * * *',
--     $$select public.cleanup_expired_oauth_states();$$
--   );
--
-- Non exécuté automatiquement par cette migration — action optionnelle
-- pour toi, voir "Configuration encore nécessaire" dans le compte-rendu.
