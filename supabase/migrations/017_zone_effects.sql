-- =============================================================================
-- Migration: 017_zone_effects
-- Shattered Halo Campaign Manager
-- =============================================================================
-- Creates the Zone Effects system:
--   zone_effects             — reference catalogue (22 effects + corrections)
--   warp_storm_effects       — sub-table for warp-storm-region (d10 roll table)
--   campaign_zone_effects    — per-campaign assignment + fog-of-war state
--   zone_effect_trigger_log  — audit log for every benefit activation (balancing)
--   zone_effect_stats        — view aggregating trigger log for balancing
--
-- changelog:
--   2026-03-15 -- Initial migration
--     zone_effects: added scope column; dropped usage_count/times_triggered
--       (replaced by trigger log + view for accurate balancing data)
--     propaganda-tower: scoped to one named enemy to avoid multiplayer NIP
--       drain ambiguity
--     ancient-weapons-platform: added Shooting phase clause + BS3+ stat line
--     hazardous-reactor-zone: reframed as adaptive benefit -- penalty is a
--       passive global effect; minor = controller immunity; major = +1 Mv
--       and char +1W
--     warp-storm-region: references warp_storm_effects sub-table (d10 x 10)
--     despair-field: kept harsh/sector-forfeiting as designed
--     minefield-network: kept as pre-existing environmental hazard
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Shared updated_at trigger function
-- ---------------------------------------------------------------------------
create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;


-- ---------------------------------------------------------------------------
-- 1. zone_effects  -- global reference catalogue
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;

create table if not exists public.zone_effects (
  id             uuid        primary key default gen_random_uuid(),
  slug           text        unique not null,
  name           text        not null,
  category       text        not null,
  -- scope: how/when the benefit applies
  --   passive    always active while the control threshold is met
  --   per_battle activates and resets each battle
  --   one_time   single consumable use (tracked via trigger log)
  --   per_round  applies / re-rolls each campaign round
  scope          text        not null default 'per_battle'
                             check (scope in ('passive', 'per_battle', 'one_time', 'per_round')),
  lore           text        not null,
  minor_benefit  text        not null,
  major_benefit  text        not null,
  global_benefit text        not null,
  power_rating   integer     not null check (power_rating between 1 and 10),
  is_active      boolean     default true,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create index if not exists zone_effects_category_idx on public.zone_effects(category);
create index if not exists zone_effects_active_idx   on public.zone_effects(is_active);

create trigger zone_effects_updated
  before update on public.zone_effects
  for each row execute function public.update_updated_at();

alter table public.zone_effects enable row level security;

create policy "zone_effects_read_auth" on public.zone_effects
  for select using (auth.role() = 'authenticated');


-- ---------------------------------------------------------------------------
-- 2. warp_storm_effects  -- sub-table for warp-storm-region
--    d10 roll table; mirrors instability_events structure (d10, name,
--    public_text, effect_json) but is template-independent.
-- ---------------------------------------------------------------------------
create table if not exists public.warp_storm_effects (
  id          uuid    primary key default gen_random_uuid(),
  d10         integer not null check (d10 >= 1 and d10 <= 10),
  name        text    not null,
  public_text text    not null,
  -- effect_json: { "type": string, "rule": string, "severity": string }
  -- types: "narrative_only" | "battle_rule" | "mortal_wounds" | "psychic_block"
  effect_json jsonb   not null default '{}',
  is_active   boolean default true,
  created_at  timestamptz default now(),
  unique (d10)
);

alter table public.warp_storm_effects enable row level security;

create policy "warp_storm_effects_read_auth" on public.warp_storm_effects
  for select using (auth.role() = 'authenticated');


-- ---------------------------------------------------------------------------
-- 3. campaign_zone_effects  -- per-campaign assignments + fog-of-war state
--    One row per zone per campaign.
--    zone_key matches map_json zones[].key (e.g. "vault_ruins")
--    zone_name is denormalised from map_json so queries avoid re-parsing JSON.
--
-- Fog-of-war:
--   effect_revealed_at  null until controlling player hits the minor threshold
--                       (sector ownership >= ceil(zone_size / 2)).
--                       Set by check-zone-effects edge function on each round.
--   global_revealed_at  null until any player achieves full (major) control;
--                       then all other players can see the global benefit.
--
-- Consumable tracking (one_time scope effects only):
--   minor_charges_used  incremented when the minor one-time benefit is used
--   major_charges_used  incremented when the major one-time benefit is used
--   global_charges_used incremented when the global one-time benefit is used
--   Remaining uses = 1 - charges_used for one_time effects.
-- ---------------------------------------------------------------------------
create table if not exists public.campaign_zone_effects (
  id                  uuid    primary key default gen_random_uuid(),
  campaign_id         uuid    not null references public.campaigns(id) on delete cascade,
  zone_key            text    not null,
  zone_name           text    not null default '',
  zone_effect_id      uuid    not null references public.zone_effects(id),

  -- fog-of-war reveal timestamps
  effect_revealed_at  timestamptz,
  global_revealed_at  timestamptz,

  -- consumable use counters
  minor_charges_used  integer not null default 0,
  major_charges_used  integer not null default 0,
  global_charges_used integer not null default 0,

  assigned_at         timestamptz default now(),
  updated_at          timestamptz default now(),

  unique (campaign_id, zone_key)
);

create index if not exists cze_campaign_idx on public.campaign_zone_effects(campaign_id);
create index if not exists cze_effect_idx   on public.campaign_zone_effects(zone_effect_id);

create trigger campaign_zone_effects_updated
  before update on public.campaign_zone_effects
  for each row execute function public.update_updated_at();

alter table public.campaign_zone_effects enable row level security;

create policy "czfe_read_members" on public.campaign_zone_effects
  for select using (
    exists (
      select 1 from public.campaign_members cm
      where cm.campaign_id = campaign_zone_effects.campaign_id
        and cm.user_id = auth.uid()
    )
  );


-- ---------------------------------------------------------------------------
-- 4. zone_effect_trigger_log  -- audit trail for every benefit activation
--    Source of truth for balancing and for the dashboard resource card.
--    Players query their own rows to see one-time charge usage.
-- ---------------------------------------------------------------------------
create table if not exists public.zone_effect_trigger_log (
  id             uuid    primary key default gen_random_uuid(),
  campaign_id    uuid    not null references public.campaigns(id) on delete cascade,
  zone_key       text    not null,
  zone_effect_id uuid    not null references public.zone_effects(id),
  -- minor  = controlling player activated minor benefit
  -- major  = controlling player activated major benefit
  -- global = non-controlling player used global benefit
  trigger_type   text    not null check (trigger_type in ('minor', 'major', 'global')),
  triggered_by   uuid    not null references auth.users(id),
  round_number   integer not null,
  -- free-text context: "Platform shot 1 of 2", "Recon reveal: halo_spire"
  notes          text,
  created_at     timestamptz default now()
);

create index if not exists zetl_campaign_idx on public.zone_effect_trigger_log(campaign_id);
create index if not exists zetl_effect_idx   on public.zone_effect_trigger_log(zone_effect_id);
create index if not exists zetl_user_idx     on public.zone_effect_trigger_log(triggered_by);

alter table public.zone_effect_trigger_log enable row level security;

create policy "zetl_read_members" on public.zone_effect_trigger_log
  for select using (
    exists (
      select 1 from public.campaign_members cm
      where cm.campaign_id = zone_effect_trigger_log.campaign_id
        and cm.user_id = auth.uid()
    )
  );


-- ---------------------------------------------------------------------------
-- 5. zone_effect_stats  -- view for balancing / lead dashboard
--    Aggregates trigger log per effect showing minor / major / global counts.
-- ---------------------------------------------------------------------------
create or replace view public.zone_effect_stats as
select
  ze.id            as zone_effect_id,
  ze.slug,
  ze.name,
  ze.category,
  ze.scope,
  ze.power_rating,
  count(*) filter (where tl.trigger_type = 'minor')  as minor_triggers,
  count(*) filter (where tl.trigger_type = 'major')  as major_triggers,
  count(*) filter (where tl.trigger_type = 'global') as global_triggers,
  count(*)                                            as total_triggers,
  count(distinct tl.campaign_id)                     as campaigns_seen_in
from public.zone_effects ze
left join public.zone_effect_trigger_log tl on tl.zone_effect_id = ze.id
group by ze.id, ze.slug, ze.name, ze.category, ze.scope, ze.power_rating
order by total_triggers desc;


-- =============================================================================
-- 6. SEED DATA  zone_effects (22 effects)
-- =============================================================================
insert into public.zone_effects
  (slug, name, category, scope, lore, minor_benefit, major_benefit, global_benefit, power_rating)
values

('strategic-command-bunker', 'Strategic Command Bunker', 'Command', 'one_time',
 'Buried command vaults filled with ancient tactical cogitators and hololithic battle maps. Once used to coordinate planetary-scale invasions, fragments of the command systems still function.',
 'Command Reroll: Once per battle reroll a hit, wound, save, damage or battleshock roll.',
 'Priority Orders: Once per battle reroll any roll AND choose which player takes first turn.',
 'Interception Protocols: All other players gain one command reroll in their next battle.',
 7),

('tactical-relay-node', 'Tactical Relay Node', 'Command', 'passive',
 'High spires bristling with vox antennae and data relays once coordinated fleet communications. Their systems now grant powerful strategic awareness.',
 'Controller chooses the mission.',
 'Controller chooses mission AND deployment map.',
 'All other players gain +1 when rolling for attacker/defender status.',
 7),

('fortified-bastion', 'Fortified Bastion', 'Fortification', 'per_battle',
 'The ruins of defensive fortresses still stand here. Ferrocrete bunkers and reinforced battlements provide exceptional defensive cover.',
 'Prepared Positions: Defender gains Light Cover during the first battle round.',
 'Fortified Sector: Defender gains Light Cover for the entire battle.',
 'Siege Doctrine: All other players gain +1 to charge rolls when attacking this zone.',
 6),

('hidden-tunnel-network', 'Hidden Tunnel Network', 'Mobility', 'passive',
 'Beneath the zone lies a labyrinth of forgotten service tunnels and collapsed transit corridors that allow covert movement across the battlefield.',
 'Move between two sectors in this zone without spending NIP.',
 'Move between any sectors in this zone without spending NIP.',
 'All other players treat this zone as fully connected for movement.',
 6),

('ambush-network', 'Ambush Network', 'Tactics', 'per_battle',
 'Hidden trenches, collapsed ruins and prepared firing lanes create the perfect environment for devastating ambush tactics.',
 'Choose who takes first turn.',
 'Redeploy one unit after deployment but before first turn.',
 'All other players gain +1 to seize the initiative.',
 6),

('vox-interception-station', 'Vox Interception Station', 'Intel', 'one_time',
 'Old signal monitoring facilities intercept enemy communications and track battlefield movement.',
 'One time use: reveal one enemy movement in the War Bulletin.',
 'Two uses: reveal one enemy movement per use in the War Bulletin.',
 'All other players gain one free recon attempt against the controller.',
 5),

('astropathic-relay', 'Astropathic Relay', 'Intel', 'one_time',
 'Psychic relay towers allow distant astropaths to glimpse echoes of enemy movements across the warzone.',
 'One time use: reveal one random enemy sector.',
 'Two uses: reveal one random enemy sector per use.',
 'All other players may reroll one recon result this round.',
 6),

('scout-network', 'Scout Intelligence Network', 'Recon', 'one_time',
 'Local scouts, smugglers and forward observers secretly map hidden ruins and relic caches.',
 'One time use: reveal one hidden relic.',
 'Two uses: reveal one hidden relic per use.',
 'Other players gain +1 to relic discovery rolls.',
 5),

('orbital-survey-array', 'Orbital Survey Array', 'Recon', 'one_time',
 'Ancient orbital satellites still perform sporadic scans of the region, revealing buried artefacts and battlefield secrets.',
 'One time use: reveal two hidden relics anywhere on the map.',
 'Two uses: reveal two hidden relics per use anywhere on the map.',
 'All other players reveal one relic of their choice.',
 7),

('minefield-network', 'Minefield Network', 'Battlefield', 'per_battle',
 'Buried mines from ancient conflicts — laid long before this war began by forces long forgotten — still lurk beneath the surface waiting for unwary troops.',
 'Enemy units suffer -1 inch movement during the first battle round.',
 'Enemy units suffer -1 inch movement for the entire battle.',
 'All other players are aware of the minefields and ignore the first movement penalty.',
 6),

('industrial-weapons-depot', 'Manufactorum Weapon Depot', 'Logistics', 'per_battle',
 'This abandoned manufactorum once produced heavy weapons for planetary defense forces. Scattered prototypes and experimental munitions remain.',
 'While fighting in this zone, one friendly unit gains one weapon keyword: Assault, Heavy or Rapid Fire 2.',
 'While fighting in this zone, two friendly units each gain a weapon keyword.',
 'All other players may give one of their units a weapon keyword once per battle.',
 6),

('supply-depot', 'Supply Depot', 'Logistics', 'one_time',
 'Massive supply bunkers once stocked ammunition and equipment for entire armies.',
 'One time use: recruit units for -1 NIP this round.',
 'One time use: recruit units for -2 NIP this round.',
 'All other players reduce their first recruitment cost this round by 1 NIP.',
 5),

('rehabilitation-zone', 'Rehabilitation Zone', 'Logistics', 'per_battle',
 'Old medicae stations and gene-repair facilities allow wounded warriors to recover quickly.',
 'At the end of a battle in this zone, heal D3 wounds on one unit or revive one model.',
 'At the end of a battle in this zone, heal D3 wounds or revive one model on up to two units.',
 'All other players heal one wound on one unit after battles fought in this zone.',
 6),

('combat-stimm-facility', 'Combat Stimm Facility', 'Enhancement', 'passive',
 'Chemical stimulant reserves allow soldiers to push beyond normal physical limits.',
 'Friendly units gain +1 inch Movement while fighting in this zone.',
 'Friendly units gain +2 inch Movement while fighting in this zone.',
 'Other players gain +1 to Advance rolls when fighting in this zone.',
 6),

('hazardous-reactor-zone', 'Hazardous Reactor Zone', 'Environment', 'passive',
 'Ancient reactors leak volatile energy into the environment, making the battlefield unstable and dangerous. Those who master this hellscape use the radiation to their advantage.',
 'Your veterans have learned to navigate the hazardous terrain. Friendly units are immune to the -1 Advance and Charge roll penalty from the reactor radiation.',
 'Complete mastery of the radiation-soaked terrain. Friendly units gain +1 Movement and Characters gain +1 Wound while fighting in this zone.',
 'All units (except the controlling player''s) suffer -1 to both Advance and Charge rolls while fighting in this zone.',
 5),

('warp-storm-region', 'Warp Storm Region', 'Environment', 'per_round',
 'Reality itself bends here as warp energy leaks into the physical world. Strange phenomena plague the battlefield.',
 'Roll once on the Warp Storm Effects table at the start of each battle round.',
 'Roll twice on the Warp Storm Effects table at the start of each battle round and choose one result.',
 'Other players may reroll their first failed psychic test per battle.',
 7),

('radiation-zone', 'Radiation Zone', 'Environment', 'per_battle',
 'Strange radiation saturates this battlefield. While dangerous to most life, some warriors emerge stronger and mutated by its influence.',
 'Characters gain +1 Wound to their profile while fighting in this zone.',
 'Characters gain +1 Wound and +1 Attack while fighting in this zone.',
 'All other players gain a 5+ invulnerable save while fighting in this zone.',
 6),

('ash-waste-storm', 'Ash Waste Storm', 'Environment', 'per_battle',
 'Massive dust storms fill the sky with choking ash, reducing visibility across the battlefield.',
 'Ranged attacks beyond 24 inches suffer -1 to hit.',
 'Ranged attacks beyond 18 inches suffer -1 to hit.',
 'Other players ignore the first visibility penalty.',
 6),

('heroic-monument', 'Heroic Monument', 'Morale', 'per_battle',
 'A colossal statue commemorates fallen heroes of ancient wars. Its presence inspires warriors to stand their ground.',
 'One friendly unit automatically passes battleshock tests while fighting in this zone.',
 'Two friendly units automatically pass battleshock tests while fighting in this zone.',
 'Other players gain +1 Leadership against the controller''s units in this zone.',
 5),

('despair-field', 'Despair Field', 'Morale', 'per_battle',
 'A strange psychic resonance permeates this region, draining hope from those who fight here.',
 'From battle round 2 onward, any army that fails a battleshock test immediately retreats from combat and forfeits the sector to the opposing player.',
 'Battleshock penalty escalates each round: -1 Ld in round 3, -2 Ld in round 4, -3 Ld in round 5. Failure still forfeits the sector.',
 'All other players may reroll battleshock tests while fighting in this zone.',
 6),

('propaganda-tower', 'Propaganda Broadcast Tower', 'Influence', 'one_time',
 'Loudspeakers and holo-projectors broadcast propaganda designed to demoralize enemy troops.',
 'Once per battle, choose one enemy player — that player loses 1 NIP (minimum 1).',
 'Once per battle, choose one enemy player — that player loses 2 NIP (minimum 1).',
 'All other players gain +1 NIP when winning a battle against the controller in this zone.',
 7),

('ancient-weapons-platform', 'Ancient Weapons Platform', 'Relic', 'per_battle',
 'An automated defence turret from a long-forgotten war still tracks targets across the battlefield.',
 'The controlling player fires this platform once per battle during their Shooting phase: BS3+ S12 AP-3 D6+1 damage.',
 'The controlling player fires this platform twice per battle during their Shooting phase: BS3+ S12 AP-3 D6+1 damage.',
 'Other players impose -1 to hit on the first platform shot each battle.',
 7)

on conflict (slug) do update set
  name           = excluded.name,
  category       = excluded.category,
  scope          = excluded.scope,
  lore           = excluded.lore,
  minor_benefit  = excluded.minor_benefit,
  major_benefit  = excluded.major_benefit,
  global_benefit = excluded.global_benefit,
  power_rating   = excluded.power_rating;


-- =============================================================================
-- 7. SEED DATA  warp_storm_effects (d10 table, 10 entries)
--    effect_json types: "narrative_only" | "battle_rule" | "mortal_wounds" |
--                       "psychic_block"
-- =============================================================================
insert into public.warp_storm_effects (d10, name, public_text, effect_json)
values

(1,
 'Empyrean Static',
 'A wall of psychic interference rolls across the battlefield. The warp grows quiet — unnervingly so. All psykers clutch their heads as the empyrean falls silent.',
 '{"type":"psychic_block","rule":"All psychic tests automatically fail this battle round. Perils of the Warp still applies on unmodified double 1s.","severity":"minor"}'
),

(2,
 'Daemonic Whispers',
 'Disembodied voices fill every vox-channel, whispering doubts and fears. Warriors hesitate, commanders second-guess themselves.',
 '{"type":"battle_rule","rule":"All units suffer -1 Leadership until the end of this battle round. Units that fail a Battleshock test this round cannot make a Heroic Intervention.","severity":"minor"}'
),

(3,
 'Warp Tide',
 'A surge of raw empyrean energy washes over the battlefield. Reality ripples. Warriors on both sides stagger as the warp pushes through them.',
 '{"type":"mortal_wounds","rule":"At the start of this battle round each player rolls a D6 for one unit of their choice. On a 1-2 that unit suffers D3 mortal wounds. On a 3+ it suffers 1 mortal wound and gains +1 Attack until the end of the round.","severity":"moderate"}'
),

(4,
 'Reality Fracture',
 'A section of the battlefield shimmers and tears. Terrain buckles, walls collapse, the ground itself becomes unreliable.',
 '{"type":"battle_rule","rule":"Nominate one piece of terrain (agreed by both players). It counts as Dangerous Terrain for all units this battle round. At the end of the round it is removed from the battlefield.","severity":"moderate"}'
),

(5,
 'Temporal Echo',
 'Time stutters. Warriors experience a second of deja vu, then a moment of paralysis as echoes of past battles overlap the present.',
 '{"type":"battle_rule","rule":"All units treat the current battle round as one lower for any effect with a round threshold. Rules that activate from round 2 onward are inactive; rules that deactivate after round 1 reactivate.","severity":"minor"}'
),

(6,
 'Psychic Backlash',
 'The psyker mind is flooded with howling empyrean energy. The feedback is catastrophic, arcing across the battlefield in blinding forks of warp lightning.',
 '{"type":"mortal_wounds","rule":"Each player''s most expensive-points CHARACTER (or warlord if unknown) suffers D3 mortal wounds. This cannot be prevented by invulnerable saves.","severity":"major"}'
),

(7,
 'Warp Surge',
 'Manic empyrean energy floods the bodies of warriors on both sides. Movement becomes frantic, reaction speeds heighten — and self-control vanishes.',
 '{"type":"battle_rule","rule":"All units gain +1 Attack this battle round. However all units must make a Charge move if an enemy is within 12 inches at the start of the Charge phase unless they pass a Leadership test.","severity":"moderate"}'
),

(8,
 'Veil Collapse',
 'A portion of the veil between realspace and the warp collapses. Units near the tear are partially phased into the empyrean before snapping violently back.',
 '{"type":"battle_rule","rule":"At the start of this battle round each player must move one unit within 6 inches of any battlefield edge D6 inches directly away from the nearest edge. This is not a normal move and ignores terrain.","severity":"moderate"}'
),

(9,
 'Soul Drain',
 'The warp hungers. An invisible cold settles over the battlefield and the weakest souls feel their essence tugged toward the empyrean.',
 '{"type":"mortal_wounds","rule":"Any unit that fails a Battleshock test this round suffers 1 additional mortal wound. Heroes who fall back from combat suffer D3 mortal wounds instead of 1.","severity":"major"}'
),

(10,
 'Eye of the Storm',
 'Without warning the warp calms completely. The silence is absolute — and deeply wrong. Veterans know what follows an eye of the storm.',
 '{"type":"battle_rule","rule":"This battle round all shooting, psychic and fight phase attacks re-roll hit rolls of 1. At the end of the round roll a D6: on a 4+ the calm ends catastrophically and every unit on the battlefield suffers 1 mortal wound.","severity":"major"}'
)

on conflict (d10) do update set
  name        = excluded.name,
  public_text = excluded.public_text,
  effect_json = excluded.effect_json;
