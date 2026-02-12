-- Evolution Pack Seed: Relics + Instability Events
with t as (
  select id as template_id
  from public.templates
  where name = 'Embers of the Shattered Halo – Production'
  limit 1
)
insert into public.relics (template_id, name, lore, rarity, phase_min, zone_tags, effect_json, is_active)
select
  t.template_id,
  v.name,
  v.lore,
  v.rarity,
  v.phase_min,
  v.zone_tags::jsonb,
  v.effect_json::jsonb,
  true
from t
cross join (values
  ('Cinder-Keystone','A palm-sized hexagonal core that radiates faint heat. It refuses to be cooled. The air tastes of ash.','common',1,'["vault_ruins","sunken_manufactorum"]','{"type":"economy","effect":"+1_nip_on_objective"}'),
  ('The Vox-Null Reliquary','A sealed canister that devours sound. Within 6m, vox is static and prayer becomes a whisper.','rare',1,'["signal_crater","ash_wastes"]','{"type":"battle","effect":"once_per_battle_cancel_stratagem"}'),
  ('Obsidian Prism of Vhelt','A black prism that refracts light into impossible angles. Auspex shows enemies where none exist.','rare',2,'["obsidian_fields","halo_spire"]','{"type":"fog","effect":"recon_reveal_extra_sector"}'),
  ('The Spire Crown Fragment','A jagged arc of auramite-like metal. It pulses with the Halo’s tremors.','legendary',3,'["halo_spire"]','{"type":"endgame","effect":"double_vp_on_primary_once"}'),
  ('Warp-Skin Lattice','A ribbon of semi-sentient plating that crawls when watched. It stitches reality… or unzips it.','legendary',3,'["warp_scar_basin"]','{"type":"hazard","effect":"enemy_within_6_take_mw_on_1s"}')
) as v(name,lore,rarity,phase_min,zone_tags,effect_json);

with t as (
  select id as template_id
  from public.templates
  where name = 'Embers of the Shattered Halo – Production'
  limit 1
)
insert into public.instability_events (template_id, threshold_min, d10, name, public_text, effect_json, is_active)
select
  t.template_id,
  v.threshold_min,
  v.d10,
  v.name,
  v.public_text,
  v.effect_json::jsonb,
  true
from t
cross join (values
  (0, 1, 'Static Chorus', 'Vox channels fill with overlapping prayers in dead tongues. Commanders report headaches and phantom orders.', '{"type":"flavour"}'),
  (0, 2, 'Ashfall', 'Fine ash drifts across auspex lenses. Visibility drops. Tracks appear where no one walked.', '{"type":"twist","tag":"low_visibility"}'),
  (0, 3, 'Machine-Whisper', 'Servo-skulls deviate from route, insisting on “a better path.” One returns with someone else’s heraldry.', '{"type":"intel","tag":"false_contact"}'),
  (0, 4, 'Hollow Footsteps', 'In the Vault Ruins, footsteps echo in empty corridors. They do not match your patrol cadence.', '{"type":"flavour"}'),
  (0, 5, 'Red Star Flare', 'The dying star flares. Auspex briefly saturates. All forces receive conflicting coordinates.', '{"type":"twist","tag":"sensor_blackout"}'),
  (0, 6, 'Blood-Sand Vortex', 'Aspirated grit cuts seals and filters. Vehicles stall. Infantry advance slows.', '{"type":"movement","tag":"slow"}'),
  (0, 7, 'Spore Bloom', 'Xenos spores blossom in heat. Lungs burn. Bio-readings spike, then vanish.', '{"type":"hazard","tag":"toxic"}'),
  (0, 8, 'Beacon Flicker', 'Signal relays pulse in a repeating pattern: a warning, or an invitation.', '{"type":"objective","tag":"signal"}'),
  (0, 9, 'Echo-Volley', 'Weapons report firing when safeties are engaged. Some shots land as if guided.', '{"type":"battle","tag":"misfire"}'),
  (0,10, 'Nightglass', 'A thin black sheen forms on armour plates. It reflects faces that are not yours.', '{"type":"flavour"}'),

  (4, 1, 'Warp Tremor', 'Reality ripples. A sector’s edges shimmer; compasses spin. Battlefields feel “tilted.”', '{"type":"hazard","tag":"warp_tremor"}'),
  (4, 2, 'Grav Inversion', 'For seconds at a time, gravity forgets its direction.', '{"type":"battle","tag":"unstable_grav"}'),
  (4, 3, 'Howling Auspex', 'Auspex screams with impossible returns. Recon gains are unreliable but plentiful.', '{"type":"recon","tag":"risky_recon"}'),
  (4, 4, 'Rift-Glow', 'A hairline crack in the air emits violet light. Unshielded minds dream of crowns and ash.', '{"type":"flavour"}'),
  (4, 5, 'Clock-Skip', 'Chronometers jump forward. A volley lands before the trigger is pulled.', '{"type":"battle","tag":"time_skip"}'),
  (4, 6, 'Canted Geometry', 'Corridors angle wrong. Units emerge in the “same” room from different doors.', '{"type":"movement","tag":"maze"}'),
  (4, 7, 'Null Hush', 'Sound dies in a wide radius. Orders must be hand-signed and relayed by touch.', '{"type":"battle","tag":"no_vox"}'),
  (4, 8, 'Grave-Lights', 'Pale lights lead patrols toward “safe routes.” Survivors disagree on what they saw.', '{"type":"intel","tag":"lure"}'),
  (4, 9, 'Halo Spasm', 'The Halo shifts slightly. Debris rain peppers upper levels.', '{"type":"hazard","tag":"debris"}'),
  (4,10, 'Ashen Omen', 'A crown symbol appears in soot on bulkheads. No one admits painting it.', '{"type":"foreshadow","tag":"ashen_king"}'),

  (8, 1, 'Relic Storm', 'Shards of data and light streak across the sky. Relics “wake,” and the Halo answers.', '{"type":"relic","tag":"storm"}'),
  (8, 2, 'Sector Shear', 'A border tears; map routes shift. One sector becomes inaccessible until repaired.', '{"type":"map","tag":"block_sector"}'),
  (8, 3, 'Crown Signal', 'A command-frequency pulse overrides local vox: “KNEEL.”', '{"type":"battle","tag":"command_denial"}'),
  (8, 4, 'Manufactorum Awakening', 'Dormant lines power up. Conveyor belts run. Cutter-arms swing. The floor becomes hostile.', '{"type":"hazard","tag":"machinery"}'),
  (8, 5, 'Forest Hunt', 'The Xenos Forest reorganizes itself. Paths close. Predators follow heat signatures.', '{"type":"hazard","tag":"predators"}'),
  (8, 6, 'Spire Lightning', 'Arcs jump between pylons. High ground is deadly—yet vital.', '{"type":"battle","tag":"lightning"}'),
  (8, 7, 'Vault Alarm', 'Ancient vault alarms blare. Auto-turrets track movement with calm certainty.', '{"type":"hazard","tag":"turrets"}'),
  (8, 8, 'Warp Bloom', 'The Warp Scar Basin exhales. Reality softens. The unlucky vanish mid-step.', '{"type":"hazard","tag":"warp_bloom"}'),
  (8, 9, 'Ashen Edict', 'Every display shows: “BALANCE MUST BE PAID.”', '{"type":"endgame","tag":"edict"}'),
  (8,10, 'Approaching Collapse', 'Structural stress reaches critical. Extraction windows narrow.', '{"type":"endgame","tag":"evac"}')
) as v(threshold_min,d10,name,public_text,effect_json);
