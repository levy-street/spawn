// Tailwind v4 uses a single PostCSS plugin entry; no autoprefixer needed
// (Tailwind handles vendor prefixing internally).
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
