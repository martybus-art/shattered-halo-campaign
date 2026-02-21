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
        void: "#0e0e11",
        steel: "#1a1a1f",
        brass: "#b08d57",
        parchment: "#e8dcc6",
        blood: "#7a1f1f",
      },
      fontFamily: {
        gothic: ["ui-serif", "Georgia", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      boxShadow: {
        halo: "0 0 20px rgba(176,141,87,0.35)",
      }
    }
  },
  plugins: []
};
