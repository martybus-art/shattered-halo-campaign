-- 009_seed_missions.sql
-- Seeds missions for any existing template rows.
-- assign-missions requires at least one active mission to function.
-- Missions are scoped to a template_id; we insert them for all existing templates.
-- Safe to run multiple times (ON CONFLICT DO NOTHING).

DO $$
DECLARE
  v_template_id uuid;
BEGIN
  FOR v_template_id IN SELECT id FROM public.templates LOOP

    INSERT INTO public.missions (template_id, name, description, phase_min, zone_tags, mission_type, is_active)
    VALUES
      (v_template_id,
       'Territorial Hold',
       'Establish dominance over the contested sector. Hold the objective against all challengers until the final bell of war tolls.',
       1, '[]', 'hold', true),

      (v_template_id,
       'Lightning Raid',
       'Strike fast, bleed the enemy dry, and withdraw before reinforcements arrive. Victory is measured in destruction, not territory.',
       1, '[]', 'raid', true),

      (v_template_id,
       'Relic Recovery',
       'The artefact pulses with power that predates the Imperium itself. Recover it before your enemy can claim its secrets.',
       1, '["vault_ruins","halo_spire","iron_sanctum"]', 'retrieval', true),

      (v_template_id,
       'Decapitation Strike',
       'The enemy commander must not survive the day. Cut off the head and let the body wither.',
       1, '[]', 'assassination', true),

      (v_template_id,
       'Dark Ritual',
       'The site thrums with fell energies. Complete the rite before the opposition can desecrate it — or claim it for themselves.',
       1, '["warp_scar_basin","signal_crater","null_fields"]', 'ritual', true),

      (v_template_id,
       'Sabotage the Supply Lines',
       'Cripple the enemy war machine by destroying key infrastructure. Leave nothing standing that could feed their advance.',
       1, '["sunken_manufactorum","obsidian_fields","iron_sanctum"]', 'sabotage', true),

      (v_template_id,
       'Void-Break Assault',
       'Storm the fortified position with overwhelming force. The walls will fall — it is only a matter of cost.',
       2, '[]', 'hold', true),

      (v_template_id,
       'Hunt the Xenos Cache',
       'Ancient xenos technology lies dormant in the ruins. Both sides want it. Neither will share.',
       2, '["xenos_forest","ghost_harbor","blighted_reach"]', 'retrieval', true)

    ON CONFLICT DO NOTHING;

  END LOOP;
END $$;
