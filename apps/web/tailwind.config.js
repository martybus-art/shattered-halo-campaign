/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx}",
    "./src/components/**/*.{js,ts,jsx,tsx}",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      /**
       * Keep the original color keys used throughout the UI (void/steel/brass/parchment/blood)
       * but remap them to the new palette so we don't have to touch page layouts.
       */
      colors: {
        // Background + surfaces
        void: "#f8f5f6",        // app background
        iron: "#ffffff",        // card surface (was used but missing)
        steel: "#424696",       // primary/indigo
        parchment: "#111827",   // primary text on light background

        // Accents
        brass: "#FBB874",       // warm accent
        ember: "#FB6812",       // warning/action
        blood: "#E64100",       // danger/destructive

        // Raw palette names (handy for future)
        indigo: "#424696",
        mist: "#E7D6D6",
        sand: "#FBB874",
        inferno: "#E64100",
      },
      fontFamily: {
        gothic: ["ui-serif", "Georgia", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      boxShadow: {
        // Used by older UI bits
        halo: "0 0 20px rgba(66,70,150,0.18)",
        // Used by Card.tsx but missing
        reliquary: "0 10px 30px rgba(17,24,39,0.10)"
      }
    }
  },
  plugins: []
};