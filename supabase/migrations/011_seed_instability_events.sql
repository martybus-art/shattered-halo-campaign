-- ============================================================================
-- Instability Events Seed — Updated with structured effect_json
-- Template: Embers of the Shattered Halo – Production
-- template_id: 8147ef28-7fd8-411b-a35a-b0ff863aae28
-- 
-- Effect types understood by apply-instability edge function:
--   narrative_only       No automated action
--   battle_rule          "rule" text shown to lead; stored in bulletin. No automation.
--   manual               "instruction" text shown to lead. No automation.
--   nip_penalty_all      Deducts amount NIP from all active players
--   nip_gain_all         Adds amount NIP to all active players
--   nip_gain_last        Gives nip NIP + ncp NCP to the lowest-NCP player
--   recon_cancel         Refunds all recon tokens purchased this round
--   deep_strike_cost     Sets campaign.rules_overrides.deep_strike_nip_cost
--   relic_nip_gain       Gives amount NIP to each relic holder
--   campaign_end_trigger Sets campaign.rules_overrides.ending_triggered = true
--   sector_remove        Lead selects count zones → added to destroyed_zones
--   zone_battle_hazard   Lead selects zone → stored in round_conditions
--   zone_impassable      Lead selects zone → stored in round_conditions
--   zone_sensor_blind    Lead selects zone → stored in round_conditions
--   zone_nip_penalty     Lead selects zone → players in that zone lose amount NIP
-- ============================================================================

-- Clear existing events for this template first (safe to re-run)
DELETE FROM instability_events WHERE template_id = '8147ef28-7fd8-411b-a35a-b0ff863aae28';

INSERT INTO instability_events
  (template_id, threshold_min, d10, name, public_text, effect_json, is_active)
VALUES

-- ═══════════════════════════════════════════════════════════════════════════
-- BAND 0: instability 1–3 — The Embers Stir
-- ═══════════════════════════════════════════════════════════════════════════

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 0, 1,
 'Vox Static',
 'Vox-channels across the Halo fill with grinding static. Transmissions become unreliable. Commanders issue orders into silence, unsure if they are heard.',
 '{"type":"narrative_only"}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 0, 2,
 'Ash Wind',
 'A choking wave of particulate ash rolls across the contested zones. Visibility drops to nothing for hours. When it clears, landmarks have shifted.',
 '{"type":"battle_rule","rule":"All units treat all terrain as difficult terrain during movement this round. Describe battles as occurring in near-zero visibility."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 0, 3,
 'Tremor in the Deep',
 'Seismic groaning rises from beneath the Halo''s crust. Buildings shudder. A minor collapse somewhere on the map changes the tactical picture.',
 '{"type":"zone_impassable","instruction":"Select one zone — all movement into or through it is blocked this round."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 0, 4,
 'Carrion Flock',
 'Vast flocks of dark-feathered xenos fauna descend on the warzone, drawn by the smell of battle. Their presence unnerves even veterans hardened by centuries of war.',
 '{"type":"narrative_only"}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 0, 5,
 'Tainted Water',
 'The recyc-wells begin producing brackish, discoloured water. Medicae teams report strange ailments. Morale is fractionally lower, but no one is dying yet.',
 '{"type":"narrative_only"}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 0, 6,
 'Night That Would Not End',
 'The Halo''s rotational pattern stutters. A prolonged artificial night blankets half the warzone. Darkness-adapted creatures move through the outer sectors unseen.',
 '{"type":"battle_rule","rule":"All battles this round are fought in Darkness conditions. Units more than 18 inches apart cannot target each other with shooting attacks unless they have the NIGHT VISION keyword or equivalent."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 0, 7,
 'Mass Desertion',
 'A conscript regiment breaks and scatters into the ruins. Their arms caches go unguarded. Word spreads among the factions — the ground is shifting beneath them all.',
 '{"type":"nip_penalty_all","amount":1}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 0, 8,
 'Relic Pulse',
 'A buried artefact emits a short electromagnetic pulse. Sensors scramble. A few pilots fly blind for hours. The pulse''s origin cannot be pinpointed.',
 '{"type":"zone_sensor_blind","instruction":"Select one zone — recon intelligence does not apply to that zone this round regardless of token purchases."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 0, 9,
 'Whispers on the Noosphere',
 'Mechanicus adepts report anomalous data-hymns propagating through the local Noosphere. The signals are ancient. Their origin is unclear. Their meaning is disputed.',
 '{"type":"narrative_only"}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 0, 10,
 'Old War Wakes',
 'A forgotten minefield — laid by a prior war centuries ago — activates spontaneously along a contested border. Nobody crossed it. Something beneath the surface stirred it.',
 '{"type":"zone_impassable","instruction":"Select one zone — all movement into or through it is blocked this round. Describe it as riddled with unexploded ordnance."}',
 true),


-- ═══════════════════════════════════════════════════════════════════════════
-- BAND 4: instability 4–7 — The Halo Burns
-- ═══════════════════════════════════════════════════════════════════════════

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 4, 1,
 'The Spire Bleeds',
 'The Halo Spire begins weeping a dark, viscous fluid from fissures along its mid-section. Servitors sent to investigate do not return. The fluid is warm.',
 '{"type":"zone_battle_hazard","instruction":"Units with their warlord in this zone suffer d3 mortal wounds on the warlord at the start of each battle round."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 4, 2,
 'Supply Lines Severed',
 'Raider bands have cut the primary supply corridors. Reinforcements are delayed. Ammunition becomes precious. Every faction bleeds resources.',
 '{"type":"nip_penalty_all","amount":2}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 4, 3,
 'Relic Surge',
 'One of the Halo''s sealed vaults cracks open without warning. Whatever is inside is broadcasting. Every faction holding a relic feels it resonate.',
 '{"type":"relic_nip_gain","amount":1}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 4, 4,
 'Warp Scar Widens',
 'The local Geller field fluctuates. A thin patch of reality tears near the approach zones. Psykers report pressure behind their eyes. Something notices.',
 '{"type":"battle_rule","rule":"Psyker units suffer Perils of the Warp on any double result when manifesting powers this round, not just 2s. Warp charges cost 1 additional CP."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 4, 5,
 'Plague Wind',
 'A biotoxin cloud of unknown origin rolls through the mid-zones. Unprotected infantry sicken within hours. Those in sealed armour watch the unprotected suffer.',
 '{"type":"battle_rule","rule":"Units without the VEHICLE, CAVALRY, TITANIC, or POWER ARMOUR keyword treat all terrain as difficult terrain and cannot advance. Describe casualties as plague-driven attrition."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 4, 6,
 'Blackout Protocols',
 'Someone has activated ancient Mechanicus blackout protocols. All auspex and scanner technology goes dark for a full rotation. The recon phase yields nothing.',
 '{"type":"recon_cancel"}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 4, 7,
 'Faction Reinforcements — Enemy',
 'A previously uninvolved warband enters the theatre. They have not declared allegiance. They attack the strongest-positioned faction on sight.',
 '{"type":"manual","instruction":"Identify the player with the most sectors. That player records a narrative defeat this round against an unnamed enemy force and loses 1 NCP. Record in the chronicle."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 4, 8,
 'Sector Collapse',
 'Without warning, a contested sector simply ceases to be viable. The ground gives way, the structures implode, or something far worse occurs beneath it. The zone is gone.',
 '{"type":"sector_remove","count":1}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 4, 9,
 'Daemonic Incursion — Minor',
 'A small but real daemonic manifestation erupts in one of the mid-zone sectors. It is contained — barely. The cost in blood and sanity is noted.',
 '{"type":"zone_nip_penalty","amount":1,"instruction":"Select one zone — all players with forces in that zone lose 1 NIP. The daemonic incursion consumed their resources."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 4, 10,
 'Phase Tremor',
 'The Halo''s structural integrity wavers. Entire districts shift. Routes that were open are now rubble. Routes that were blocked are now navigable.',
 '{"type":"manual","instruction":"Redraw adjacency for one zone pair on the map — one existing connection closes, one new connection opens between non-adjacent zones. Update the campaign map and announce the changes."}',
 true),


-- ═══════════════════════════════════════════════════════════════════════════
-- BAND 8: instability 8–10 — Collapse
-- ═══════════════════════════════════════════════════════════════════════════

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 8, 1,
 'The Ashen King Stirs',
 'Deep within the Halo''s core, something dormant for ten thousand years becomes aware of the war being fought above it. Its dreams bleed upward.',
 '{"type":"battle_rule","rule":"All players lose 1 Command Point at the start of their next battle. If a player has 0 CP, their warlord instead suffers 1 mortal wound at battle start. The Ashen King reaches into the minds of the strong."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 8, 2,
 'Cascade Collapse',
 'Three sectors fail simultaneously. The screaming of their populations, if any remained, is brief. The Halo is visibly smaller now. Everyone can see it.',
 '{"type":"sector_remove","count":3}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 8, 3,
 'The Veil Tears',
 'Reality fractures along a ley line running through the central warzone. Daemons pour through in numbers that overwhelm local defences. This is no longer a contained war.',
 '{"type":"battle_rule","rule":"At the start of each battle round, each player rolls a d6. On a 1, their warlord suffers 1 mortal wound as a daemonic manifestation tears through nearby reality. No saves of any kind are permitted."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 8, 4,
 'Null Field',
 'A massive psychic null event wipes the Noosphere clean. Psykers across the Halo are rendered catatonic. Even non-psykers feel the silence as a physical weight.',
 '{"type":"battle_rule","rule":"No psychic powers may be cast in any battle this round. All Deny the Witch attempts auto-succeed on any result. Psyker models that attempted to manifest suffer Perils automatically regardless."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 8, 5,
 'The Last Broadcast',
 'A vox-choir of dying voices transmits from somewhere beneath the Spire. They are naming factions. They are naming commanders. They are listing the dead. The list is very long.',
 '{"type":"manual","instruction":"Read a brief public list of commanders and factions who have fallen in prior rounds. Post to the chronicle. No mechanical effect — this is pure dread and narrative weight."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 8, 6,
 'Orbital Interference',
 'An unknown vessel of immense tonnage has entered low orbit. It is not responding to hails. It is not firing. It is watching. Its shadow crosses the warzone at irregular intervals.',
 '{"type":"deep_strike_cost","cost":5}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 8, 7,
 'Forgotten Engine Wakes',
 'A Titan-class war engine sealed in a vault beneath the Ash Wastes for ten thousand years activates. Its allegiance — if it has one — is unclear. Its weapons are not.',
 '{"type":"zone_battle_hazard","instruction":"Both players in battles fought in this zone suffer d3 mortal wounds on their warlord at the start of every battle round. The engine fires indiscriminately. No saves permitted."}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 8, 8,
 'Mass Psychic Event',
 'Every psyker simultaneously suffers a vision of the same thing. No two of them describe it the same way. All of them weep. The clarity of it is terrible.',
 '{"type":"nip_gain_all","amount":1}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 8, 9,
 'Point of No Return',
 'A senior Inquisitorial delegation arrives in-system. They observe the warzone. They declare Exterminatus proceedings have been initiated. The factions have one final phase to resolve the matter themselves.',
 '{"type":"campaign_end_trigger"}',
 true),

('8147ef28-7fd8-411b-a35a-b0ff863aae28', 8, 10,
 'The Void Speaks',
 'Whatever intelligence remains in its dying substrate — reaches out and touches every commander simultaneously. It has seen wars before. It knows which ones end badly.',
 '{"type":"nip_gain_last","nip":3,"ncp":1}',
 true);
