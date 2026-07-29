// React Native's development inspector still reads the browser alias while its
// module graph is being initialized. Install it before requiring React Native;
// production code continues to use globalThis and native APIs directly.
globalThis.window ??= globalThis;

const { AppRegistry } = require("react-native");
const App = require("./src/App").default;
const { name: appName } = require("./app.json");

AppRegistry.registerComponent(appName, () => App);
