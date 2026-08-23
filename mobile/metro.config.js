const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const outsideMobileBlockList = ["web", "server", "daemon", "node_modules"].map(
  (name) => new RegExp(`^${escapeForRegExp(path.resolve(__dirname, "..", name))}[/\\\\].*$`),
);

const defaultBlockList = config.resolver.blockList;

config.watchFolders = [];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
config.resolver.blockList = [
  ...(Array.isArray(defaultBlockList)
    ? defaultBlockList
    : defaultBlockList
      ? [defaultBlockList]
      : []),
  ...outsideMobileBlockList,
];

module.exports = config;
