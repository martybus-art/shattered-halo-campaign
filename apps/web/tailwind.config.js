/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx}",
    "./src/components/**/*.{js,ts,jsx,tsx}",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        void: "#0b0d10",
        iron: "#111318",
        brass: "#8a6d3b",
        blood: "#6b0f1a",
        parchment: "#d8c7a3"
      },
      fontFamily: {
        gothic: ["ui-serif", "Georgia", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      boxShadow: {
        reliquary: "0 0 0 1px rgba(138,109,59,0.35), 0 10px 30px rgba(0,0,0,0.6)"
      }
    }
  },
  plugins: []
};
