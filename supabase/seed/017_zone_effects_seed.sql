-- ============================================================
-- Seed 017: Zone Effects & Warp Storm Effects
-- ============================================================
-- changelog:
--   2026-03-15 -- Initial seed.
--                 22 zone effects with scope column.
--                 10 warp storm effects (d10 roll table).
--                 Revised effects vs draft:
--                   propaganda-tower: "enemy" now "one chosen enemy player"
--                   ancient-weapons-platform: shooting phase clarified
--                   hazardous-reactor-zone: reframed around controller learning curve
--                   warp-storm-region: references warp_storm_effects roll table
--                 despair-field, minefield-network left as designed (intentional).
-- ============================================================

-- ── zone_effects seed ─────────────────────────────────────────────────────────
-- Run with ON CONFLICT DO NOTHING so it is safe to re-run on existing campaigns.

insert into public.zone_effects
(slug, name, category, scope, lore, minor_benefit, major_benefit, global_benefit, power_rating)
values

(
  'strategic-command-bunker',
  'Strategic Command Bunker',
  'Command',
  'per_battle',
  'Buried command vaults filled with ancient tactical cogitators and hololithic battle maps. Once used to coordinate planetary-scale invasions, fragments of the command systems still function.',
  'Command Reroll: Once per battle, reroll a hit, wound, save, damage, or battleshock roll.',
  'Priority Orders: Once per battle, reroll a roll AND choose which player takes first turn.',
  'Interception Protocols: All other players gain one command reroll in their next battle.',
  7
),

(
  'fortified-bastion',
  'Fortified Bastion',
  'Fortification',
  'per_battle',
  'The ruins of defensive fortresses still stand here. Ferrocrete bunkers and reinforced battlements provide exceptional defensive cover.',
  'Prepared Positions: Defender gains Light Cover during the first battle round.',
  'Fortified Sector: Defender gains Light Cover for the entire battle.',
  'Siege Doctrine: All other players gain +1 to charge rolls when attacking this zone.',
  6
),

(
  'tactical-relay-node',
  'Tactical Relay Node',
  'Command',
  'permanent',
  'High spires bristling with vox antennae and data relays once coordinated fleet communications. Their systems now grant powerful strategic awareness.',
  'Controller chooses the mission.',
  'Controller chooses mission AND deployment map.',
  'All other players gain +1 when rolling for attacker/defender.',
  7
),

(
  'hidden-tunnel-network',
  'Hidden Tunnel Network',
  'Mobility',
  'permanent',
  'Beneath the zone lies a labyrinth of forgotten service tunnels and collapsed transit corridors that allow covert movement across the battlefield.',
  'Move between two sectors in this zone without spending NIP.',
  'Move between any sectors in this zone without spending NIP.',
  'All other players treat this zone as fully connected for movement.',
  6
),

(
  'ambush-network',
  'Ambush Network',
  'Tactics',
  'per_battle',
  'Hidden trenches, collapsed ruins and prepared firing lanes create the perfect environment for devastating ambush tactics.',
  'Choose who takes first turn.',
  'Redeploy one unit after deployment but before the first turn.',
  'All other players gain +1 to seize initiative.',
  6
),

(
  'vox-interception-station',
  'Vox Interception Station',
  'Intel',
  'one_time',
  'Old signal monitoring facilities intercept enemy communications and track battlefield movement.',
  'One-time use: reveal one enemy movement in the War Bulletin.',
  'Two uses of Signal Interception.',
  'All other players gain one free recon against the controller.',
  5
),

(
  'astropathic-relay',
  'Astropathic Relay',
  'Intel',
  'one_time',
  'Psychic relay towers allow distant astropaths to glimpse echoes of enemy movements across the warzone.',
  'One-time use: reveal one random enemy sector.',
  'Reveal two random enemy sectors.',
  'All other players may reroll one recon result this round.',
  6
),

(
  'scout-network',
  'Scout Intelligence Network',
  'Recon',
  'one_time',
  'Local scouts, smugglers and forward observers secretly map hidden ruins and relic caches.',
  'One-time use: reveal one hidden relic.',
  'Reveal two hidden relics.',
  'Other players gain +1 to relic discovery rolls.',
  5
),

(
  'orbital-survey-array',
  'Orbital Survey Array',
  'Recon',
  'one_time',
  'Ancient orbital satellites still perform sporadic scans of the region, revealing buried artefacts and battlefield secrets.',
  'One-time use: reveal two hidden relics anywhere.',
  'Reveal three hidden relics anywhere.',
  'All other players reveal one relic.',
  7
),

(
  'minefield-network',
  'Minefield Network',
  'Battlefield',
  'permanent',
  'Buried mines from ancient conflicts — planted by forces long since dust — still lurk beneath the surface. No living commander deployed them; the land itself is the threat.',
  'Enemy units suffer -1 inch to Movement in the first battle round.',
  'Enemy units suffer -1 inch to Movement for the entire battle.',
  'All other players ignore the first movement penalty when entering this zone.',
  6
),

(
  'industrial-weapons-depot',
  'Manufactorum Weapon Depot',
  'Logistics',
  'per_battle',
  'This abandoned manufactorum once produced heavy weapons for planetary defense forces. Scattered prototypes and experimental munitions remain.',
  'While fighting in this zone, one unit gains a weapon keyword: Assault, Heavy, or Rapid Fire 2.',
  'While fighting in this zone, two units gain weapon keywords.',
  'All other players may give one unit a weapon keyword once per battle.',
  6
),

(
  'hazardous-reactor-zone',
  'Hazardous Reactor Zone',
  'Environment',
  'permanent',
  'Ancient reactors leak volatile radiation and toxic runoff across this battlefield. The zone is a slow death for the unprepared — but those who master its rhythms learn to move through it like ghosts.',
  'Hazard Immunity: Your forces have learned the safe paths. Friendly units ignore all Advance and Charge roll penalties from this zone. Enemy units still suffer -1 to Advance and Charge rolls.',
  'Adaptive Mastery: Total environmental control. All friendly units gain +1 inch Movement. Enemy units still suffer -1 to Advance and Charge rolls.',
  'Other players may reroll their first failed Advance roll when fighting in this zone.',
  5
),

(
  'ancient-weapons-platform',
  'Ancient Weapons Platform',
  'Relic',
  'per_battle',
  'An automated defence turret from a long-forgotten war still tracks targets across the battlefield. The controlling player may activate it during their shooting phase.',
  'One shot per battle during your Shooting phase: BS3+ S12 AP-3 D6+1 damage.',
  'Two shots per battle during your Shooting phase: BS3+ S12 AP-3 D6+1 damage each.',
  'All other players impose -1 to hit on the first platform shot fired against them.',
  7
),

(
  'heroic-monument',
  'Heroic Monument',
  'Morale',
  'per_battle',
  'A colossal statue commemorates fallen heroes of ancient wars. Its presence inspires warriors to stand their ground.',
  'One unit automatically passes battleshock.',
  'Two units automatically pass battleshock.',
  'Other players gain +1 to Leadership against the controller.',
  5
),

(
  'propaganda-tower',
  'Propaganda Broadcast Tower',
  'Influence',
  'per_round',
  'Loudspeakers and holo-projectors broadcast propaganda designed to demoralise enemy troops.',
  'One chosen enemy player loses 1 NIP (minimum 1).',
  'One chosen enemy player loses 2 NIP (minimum 1).',
  'Other players gain +1 NIP when fighting the controller this round.',
  7
),

(
  'despair-field',
  'Despair Field',
  'Morale',
  'per_battle',
  'A strange psychic resonance permeates this region, draining hope from those who fight here.',
  'From battle round 2 onward, any army that fails a battleshock test retreats from combat and forfeits the sector.',
  'Battleshock penalty increases each round: -1 Leadership in round 3, -2 in round 4, -3 in round 5.',
  'All other players may reroll battleshock tests when fighting in this zone.',
  6
),

(
  'supply-depot',
  'Supply Depot',
  'Logistics',
  'one_time',
  'Massive supply bunkers once stocked ammunition and equipment for entire armies.',
  'One-time use: recruit units this round for -1 NIP.',
  'One-time use: recruit units this round for -2 NIP.',
  'All other players reduce their first recruit cost this round by 1 NIP.',
  5
),

(
  'rehabilitation-zone',
  'Rehabilitation Zone',
  'Logistics',
  'per_battle',
  'Old medicae stations and gene-repair facilities allow wounded warriors to recover quickly.',
  'After a battle in this zone: heal D3 wounds or revive one model.',
  'After a battle in this zone: heal D3 models or D3 wounds.',
  'All other players heal one wound after battles fought in this zone.',
  6
),

(
  'combat-stimm-facility',
  'Combat Stimm Facility',
  'Enhancement',
  'permanent',
  'Chemical stimulant reserves allow soldiers to push beyond normal physical limits.',
  '+1 inch Movement to all friendly units while fighting in this zone.',
  '+2 inch Movement to all friendly units while fighting in this zone.',
  'Other players gain +1 to Advance rolls when fighting in this zone.',
  6
),

(
  'warp-storm-region',
  'Warp Storm Region',
  'Environment',
  'per_round',
  'Reality itself bends here as warp energy leaks into the physical world. No-one controls the storms — but those who know the patterns can read them.',
  'Roll once on the Warp Storm Effects table (D10) at the start of each battle round. Apply the result.',
  'Roll twice on the Warp Storm Effects table and choose which result applies.',
  'All other players may reroll their first failed psychic test each battle.',
  7
),

(
  'radiation-zone',
  'Radiation Zone',
  'Environment',
  'permanent',
  'Strange radiation saturates this battlefield. While dangerous to most life, some warriors emerge stronger and mutated by its influence.',
  'Characters gain +1 Wound to their profile while fighting in this zone.',
  'Characters gain +1 Wound and +1 Attack while fighting in this zone.',
  'All other players gain a 5+ invulnerable save while fighting in this zone.',
  6
),

(
  'ash-waste-storm',
  'Ash Waste Storm',
  'Environment',
  'permanent',
  'Massive dust storms fill the sky with choking ash, reducing visibility across the battlefield.',
  'Ranged attacks beyond 24 inches suffer -1 to hit.',
  'Ranged attacks beyond 18 inches suffer -1 to hit.',
  'Other players ignore the first visibility penalty when fighting in this zone.',
  6
)

on conflict (slug) do nothing;


-- ── warp_storm_effects seed ───────────────────────────────────────────────────
-- 10-entry d10 roll table for the warp-storm-region zone effect.
-- Pattern mirrors instability_events (roll + lore + effect_text + effect_json).

insert into public.warp_storm_effects
(roll, name, lore, effect_text, effect_json)
values

(
  1,
  'Empyrean Calm',
  'The storm subsides for a moment. An eerie stillness falls across the battlefield. Soldiers glance skyward, unsure if the respite is a mercy or a warning.',
  'No effect this round. The warp falls quiet.',
  '{"type": "narrative_only"}'
),

(
  2,
  'Psychic Scream',
  'A wave of unfocused psychic energy erupts from a nearby rift. Psykers convulse; even null-blooded soldiers feel a spike of inexplicable terror.',
  'All units within 6" of a Psyker model must take a Battleshock test immediately.',
  '{"type": "battleshock", "trigger": "within_6_of_psyker"}'
),

(
  3,
  'Daemon Whispers',
  'Voices leak through the veil — half-heard commands, old fears, the names of the dead. No order goes uncontested by the enemy within.',
  'All models reduce their Leadership characteristic by 1 for this battle round.',
  '{"type": "stat_modifier", "stat": "leadership", "delta": -1, "duration": "battle_round"}'
),

(
  4,
  'Temporal Distortion',
  'Time stutters. Warriors blink and find themselves ten paces from where they stood. Veterans have learned not to question it — just to move fast.',
  'All Advance and Charge rolls are made with D3 instead of D6 this battle round.',
  '{"type": "roll_modifier", "rolls": ["advance", "charge"], "dice": "D3", "duration": "battle_round"}'
),

(
  5,
  'Warp Gate Flicker',
  'Brief tears in realspace open and close across the field. Squads vanish and reappear metres away, disoriented but alive.',
  'Each player may teleport one unit up to 6" in any direction, ignoring terrain. Treat as a Deep Strike arrival for targeting purposes.',
  '{"type": "movement_special", "range": 6, "ignore_terrain": true, "treat_as_deep_strike": true}'
),

(
  6,
  'Corruption Wave',
  'A tide of mutagenic warp-stuff washes across the melee. Blades glow with otherworldly heat. Warriors feel something shift beneath their skin.',
  'All melee weapons gain the Hazardous special rule for this battle round.',
  '{"type": "weapon_keyword_add", "scope": "melee", "keyword": "Hazardous", "duration": "battle_round"}'
),

(
  7,
  'Spectral Interference',
  'The warp bleeds into optical sights and targeting spirits, bending trajectories in strange ways. Every shot becomes an act of faith.',
  'All ranged weapons gain the Indirect Fire rule but lose Precision for this battle round.',
  '{"type": "weapon_keyword_swap", "scope": "ranged", "add": "Indirect Fire", "remove": "Precision", "duration": "battle_round"}'
),

(
  8,
  'Reality Fracture',
  'A localised pocket of fractured space-time seizes one unit at random, dragging it sideways through a moment of twisted geometry.',
  'Each player rolls a D6; the player with the highest roll must move one of their units D6" in a random direction (scatter). If this moves them off the board or into impassable terrain, they return to their starting position.',
  '{"type": "forced_scatter", "dice": "D6", "target": "highest_roller_unit"}'
),

(
  9,
  'Baleful Tide',
  'Invisible energies pull at warriors'' life force. Some clutch their heads and collapse; others simply vanish between heartbeats.',
  'Each player rolls a D6. On a 1, one unit of their choice loses D3 wounds with no saves of any kind allowed.',
  '{"type": "mortal_wounds", "trigger": "roll_1_on_D6", "wounds": "D3", "no_saves": true}'
),

(
  10,
  'Warp Surge',
  'Psychic energy floods the battlefield, empowering those attuned to it while making the warp itself unpredictable and wild.',
  'All Psyker models gain +1 to their next psychic test, but also suffer Perils of the Warp on any roll containing doubles.',
  '{"type": "psyker_modifier", "cast_bonus": 1, "perils_on_doubles": true, "duration": "battle_round"}'
)

on conflict (roll) do nothing;
