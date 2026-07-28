module.exports = {
  preset: "@react-native/jest-preset",
  testPathIgnorePatterns: ["/node_modules/", "/android/", "/ios/Pods/"],
  transformIgnorePatterns: [
    "node_modules/(?!.*(?:@react-native|react-native).*)"
  ]
};
