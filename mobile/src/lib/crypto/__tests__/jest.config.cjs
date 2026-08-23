const packageConfig = require("../../../../package.json");

module.exports = {
  ...packageConfig.jest,
  rootDir: "../../../..",
  transformIgnorePatterns: [
    "/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|@noble))",
    "/node_modules/react-native-reanimated/plugin/",
  ],
};
