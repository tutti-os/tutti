module.exports = {
  preset: "@react-native/jest-preset",
  testPathIgnorePatterns: ["/node_modules/", "/android/"],
  transformIgnorePatterns: [
    "node_modules/(?!.*(?:@react-native|react-native).*)"
  ]
};
