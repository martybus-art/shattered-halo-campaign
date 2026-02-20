export type FactionTheme = {
  key: string;
  name: string;
  bg: string;
  crest: string;
  preview: string;
};

export const FACTION_THEMES: FactionTheme[] = [
  { key: "space_marines", name: "Space Marines", bg: "/art/factions/space_marines/bg.jpg", crest: "/art/factions/space_marines/crest.png", preview: "/art/factions/space_marines/preview.jpg" },
  { key: "astra_militarum", name: "Astra Militarum", bg: "/art/factions/astra_militarum/bg.jpg", crest: "/art/factions/astra_militarum/crest.png", preview: "/art/factions/astra_militarum/preview.jpg" },
  { key: "adeptus_mechanicus", name: "Adeptus Mechanicus", bg: "/art/factions/adeptus_mechanicus/bg.jpg", crest: "/art/factions/adeptus_mechanicus/crest.png", preview: "/art/factions/adeptus_mechanicus/preview.jpg" },
  { key: "adepta_sororitas", name: "Adepta Sororitas", bg: "/art/factions/adepta_sororitas/bg.jpg", crest: "/art/factions/adepta_sororitas/crest.png", preview: "/art/factions/adepta_sororitas/preview.jpg" },
  { key: "orks", name: "Orks", bg: "/art/factions/orks/bg.jpg", crest: "/art/factions/orks/crest.png", preview: "/art/factions/orks/preview.jpg" },
  { key: "necrons", name: "Necrons", bg: "/art/factions/necrons/bg.jpg", crest: "/art/factions/necrons/crest.png", preview: "/art/factions/necrons/preview.jpg" },
  { key: "chaos_space_marines", name: "Chaos Space Marines", bg: "/art/factions/chaos_space_marines/bg.jpg", crest: "/art/factions/chaos_space_marines/crest.png", preview: "/art/factions/chaos_space_marines/preview.jpg" },
  { key: "tyranids", name: "Tyranids", bg: "/art/factions/tyranids/bg.jpg", crest: "/art/factions/tyranids/crest.png", preview: "/art/factions/tyranids/preview.jpg" },
  { key: "tau_empire", name: "T'au Empire", bg: "/art/factions/tau_empire/bg.jpg", crest: "/art/factions/tau_empire/crest.png", preview: "/art/factions/tau_empire/preview.jpg" },
  { key: "aeldari", name: "Aeldari", bg: "/art/factions/aeldari/bg.jpg", crest: "/art/factions/aeldari/crest.png", preview: "/art/factions/aeldari/preview.jpg" },
];

export function getFactionTheme(key?: string | null) {
  return FACTION_THEMES.find(t => t.key === key) ?? null;
}
