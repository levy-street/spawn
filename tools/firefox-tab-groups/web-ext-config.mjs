// web-ext lint / sign / build package only the add-on itself.
export default {
  ignoreFiles: [
    "dev",
    "dist",
    "build.sh",
    "README.md",
    "package.json",
    "package-lock.json",
    "web-ext-config.mjs",
  ],
};
