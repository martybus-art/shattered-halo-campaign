-- =============================================================================
-- Instability Events Seed
-- Template: Embers of the Shattered Halo – Production
-- 30 events: 10 per threshold band (0, 4, 8)
-- threshold_min 0 = instability 1–3  (Phase 1: The Embers Stir)
-- threshold_min 4 = instability 4–7  (Phase 2: The Halo Burns)
-- threshold_min 8 = instability 8–10 (Phase 3: Collapse)
-- =============================================================================

DO $$
DECLARE
  tid uuid := '8147ef28-7fd8-411b-a35a-b0ff863aae28';
BEGIN

-- ── BAND 0: instability 1–3 ── Minor disturbances, omens, eerie calm ────────

INSERT INTO instability_events
  (template_id, threshold_min, d10, name, public_text, effect_json, is_active)
VALUES

(tid, 0, 1,
 'Vox Static',
 'Vox-channels across the Halo fill with grinding static. Transmissions become unreliable. Commanders issue orders into silence, unsure if they are heard.',
 '{"hint": "No mechanical effect. Narrative flavour — comms are degraded."}',
 true),

(tid, 0, 2,
 'Ash Wind',
 'A choking wave of particulate ash rolls across the contested zones. Visibility drops to nothing for hours. When it clears, landmarks have shifted.',
 '{"hint": "Narrative only. Describe terrain differently in battle reports this round."}',
 true),

(tid, 0, 3,
 'Tremor in the Deep',
 'Seismic groaning rises from beneath the Halo''s crust. Buildings shudder. A minor collapse somewhere on the map changes the tactical picture, but no one is certain where yet.',
 '{"hint": "Lead may reclassify one sector as difficult terrain for this round."}',
 true),

(tid, 0, 4,
 'Carrion Flock',
 'Vast flocks of dark-feathered xenos fauna descend on the warzone, drawn by the smell of battle. Their presence unnerves even veterans hardened by centuries of war.',
 '{"hint": "Narrative only. Good flavour for battle descriptions this round."}',
 true),

(tid, 0, 5,
 'Tainted Water',
 'The recyc-wells begin producing brackish, discoloured water. Medicae teams report strange ailments. Morale is fractionally lower, but no one is dying yet.',
 '{"hint": "No mechanical effect this round. Escalates if instability continues to rise."}',
 true),

(tid, 0, 6,
 'Night That Would Not End',
 'The Halo''s rotational pattern stutters. A prolonged artificial night blankets half the warzone. Darkness-adapted creatures move through the outer sectors unseen.',
 '{"hint": "Narrative only. Battles this round may be described as occurring in darkness."}',
 true),

(tid, 0, 7,
 'Mass Desertion',
 'A conscript regiment breaks and scatters into the ruins. Their arms caches go unguarded. Word spreads among the factions — the ground is shifting beneath them all.',
 '{"hint": "Each player loses 1 NIP. Represent supply lines being raided by deserters."}',
 true),

(tid, 0, 8,
 'Relic Pulse',
 'A buried artefact somewhere within the Halo emits a short but powerful electromagnetic pulse. Sensors scramble. A few pilots fly blind for hours.',
 '{"hint": "Lead may declare one zone as sensor-blind for the round — no recon purchases apply there."}',
 true),

(tid, 0, 9,
 'Whispers on the Noosphere',
 'Mechanicus adepts report anomalous data-hymns propagating through the local Noosphere. The signals are ancient. Their origin is unclear. Their meaning is disputed.',
 '{"hint": "Narrative only. Strong flavour for Mechanicus or psyker-adjacent factions."}',
 true),

(tid, 0, 10,
 'Old War Wakes',
 'A forgotten minefield — laid by a prior war centuries ago — activates spontaneously along a contested border. Nobody crossed it. Something beneath the surface stirred it.',
 '{"hint": "Lead may declare one sector boundary impassable for movement this round."}',
 true),


-- ── BAND 4: instability 4–7 ── Escalating, dangerous, relics active ─────────

(tid, 4, 1,
 'The Spire Bleeds',
 'The Halo Spire begins weeping a dark, viscous fluid from fissures along its mid-section. Servitors sent to investigate do not return. The fluid is warm.',
 '{"hint": "Halo Spire zone treated as hazardous — any player ending a round there takes d3 mortal wounds in battle."}',
 true),

(tid, 4, 2,
 'Supply Lines Severed',
 'Raider bands — of uncertain affiliation — have cut the primary supply corridors. Reinforcements are delayed. Ammunition becomes precious.',
 '{"hint": "Each player loses 2 NIP. Supply caches have been hit."}',
 true),

(tid, 4, 3,
 'Relic Surge',
 'One of the Halo''s sealed vaults cracks open without warning. Whatever is inside is broadcasting. Every faction with a relic feels it resonate.',
 '{"hint": "Each player holding a relic gains 1 NIP. Lead should note which relics are in play."}',
 true),

(tid, 4, 4,
 'Warp Scar Widens',
 'The local Geller field fluctuates. A thin patch of reality tears near the eastern approach zones. Psykers report pressure behind their eyes. Something notices.',
 '{"hint": "Battles this round: psyker units suffer Perils of the Warp on any double, not just 2s."}',
 true),

(tid, 4, 5,
 'Plague Wind',
 'A biotoxin cloud of unknown origin rolls through the mid-zones. Unprotected infantry sicken within hours. Those in sealed armour watch the unprotected suffer.',
 '{"hint": "Units without sealed armour (power armour, terminator armour, vehicles) treat all movement as difficult terrain in battles this round."}',
 true),

(tid, 4, 6,
 'Blackout Protocols',
 'Someone — or something — has activated ancient Mechanicus blackout protocols. All auspex and scanner technology goes dark for a full rotation.',
 '{"hint": "Recon phase is cancelled this round. All recon token purchases are refunded (1 NIP each)."}',
 true),

(tid, 4, 7,
 'Faction Reinforcements — Enemy',
 'A previously uninvolved warband enters the theatre. They have not declared allegiance. They attack the strongest-positioned faction on sight.',
 '{"hint": "Lead identifies the player with the most sectors. That player adds 1 battle to their roster this round — against a phantom enemy (narrative loss, -1 NCP)."}',
 true),

(tid, 4, 8,
 'Sector Collapse',
 'Without warning, a contested sector simply ceases to be viable. The ground gives way, the structures implode, or something worse occurs beneath. It is gone.',
 '{"hint": "Lead removes one unoccupied contested sector from the map for the remainder of the campaign. Record it in the chronicle."}',
 true),

(tid, 4, 9,
 'Daemonic Incursion — Minor',
 'A small but real daemonic manifestation erupts in one of the mid-zone sectors. It is contained — barely — but the cost in blood and sanity is noted.',
 '{"hint": "All players with units in the affected zone take 1 NIP penalty. Lead nominates the zone."}',
 true),

(tid, 4, 10,
 'Phase Tremor',
 'The Halo''s structural integrity wavers. Entire districts shift. Routes that were open are now rubble. Routes that were blocked are now navigable.',
 '{"hint": "Lead redraws adjacency for one zone pair — one connection closes, one new connection opens. Update the map."}',
 true),


-- ── BAND 8: instability 8–10 ── Collapse, cosmic horror, endgame ────────────

(tid, 8, 1,
 'The Ashen King Stirs',
 'Deep within the Halo''s core, something that has been dormant for ten thousand years becomes aware of the war being fought above it. Its dreams bleed upward.',
 '{"hint": "All players suffer -1 to Command Points at the start of their next battle. Represent psychic interference."}',
 true),

(tid, 8, 2,
 'Cascade Collapse',
 'Three sectors fail simultaneously. The screaming of their populations, if any remained, is brief. The Halo is visibly smaller now. Everyone can see it.',
 '{"hint": "Lead permanently removes 3 unoccupied sectors from the map. If fewer than 3 are unoccupied, remove what remains and replace with rubble markers."}',
 true),

(tid, 8, 3,
 'The Veil Tears',
 'Reality fractures along a ley line running through the central warzone. Daemons of all kinds pour through in numbers that overwhelm local defences. This is no longer a contained war.',
 '{"hint": "Every battle this round includes a Chaos twist: at the start of each battle round, roll d6 — on a 1, each player''s warlord suffers 1 mortal wound."}',
 true),

(tid, 8, 4,
 'Null Field',
 'A massive psychic null event wipes the Noosphere clean. Psykers across the Halo are rendered catatonic. Even non-psykers feel the silence as a physical weight.',
 '{"hint": "No psychic powers may be cast in any battle this round. All Deny the Witch attempts auto-succeed."}',
 true),

(tid, 8, 5,
 'The Last Broadcast',
 'A vox-choir of dying voices transmits from somewhere beneath the Spire. They are naming factions. They are naming commanders. They are listing the dead. The list is very long.',
 '{"hint": "Narrative event. Lead reads a brief list of fallen commanders from prior rounds. No mechanical effect — pure dread."}',
 true),

(tid, 8, 6,
 'Orbital Interference',
 'An unknown vessel of immense tonnage has entered low orbit. It is not responding to hails. It is not firing. It is simply watching. Its shadow crosses the warzone at irregular intervals.',
 '{"hint": "Each round the vessel remains (until end of campaign): deep strike costs increase to 5 NIP. The sky is no longer safe."}',
 true),

(tid, 8, 7,
 'Forgotten Engine Wakes',
 'A Titan-class war engine — sealed in a vault beneath the Ash Wastes for ten thousand years — activates. Its allegiance, if it has one, is unclear. Its weapons are not.',
 '{"hint": "Lead designates one zone. Any battle fought there this round: both players suffer d3 mortal wounds on their warlord at battle start. The engine fires indiscriminately."}',
 true),

(tid, 8, 8,
 'Mass Psychic Event',
 'Every psyker on the Halo simultaneously suffers a vision of the same thing. No two of them describe it the same way. All of them weep.',
 '{"hint": "All players gain 1 NIP — the fear is clarifying. But each player must write a one-sentence account of what their commander witnessed. Add to the chronicle."}',
 true),

(tid, 8, 9,
 'Point of No Return',
 'A senior Inquisitorial delegation arrives in-system. They observe the warzone. They declare Exterminatus proceedings have been initiated. The factions have one final campaign phase to resolve the matter themselves.',
 '{"hint": "If instability reaches 10 after this event, the campaign ends at the conclusion of the current round regardless of any other conditions."}',
 true),

(tid, 8, 10,
 'The Halo Chooses',
 'The Shattered Halo itself — whatever intelligence remains in its dying substrate — reaches out and touches every commander simultaneously. It has seen wars before. It knows which ones end badly.',
 '{"hint": "The player currently in last place (fewest NCP) gains 3 NIP and 1 NCP immediately. The Halo favours the desperate. Record this event in the chronicle."}',
 true);

END $$;
