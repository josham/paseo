// Polyfill crypto.randomUUID for React Native before any other imports
import { polyfillCrypto } from "./src/polyfills/crypto";
polyfillCrypto();

// Polyfill navigator before Expo Router loads route modules. Anything the route graph
// reaches that expects a browser reads navigator while it is being evaluated, which is
// long before a component body could run: @xterm/headless does, through the terminal
// panel, and a native release build dies on `navigator.userAgent.includes` at launch.
import { polyfillNavigator } from "./src/polyfills/navigator";
polyfillNavigator();

// Polyfill screen.orientation for WebKitGTK desktop runtimes that lack the API.
import { polyfillScreenOrientation } from "./src/polyfills/screen-orientation";
polyfillScreenOrientation();

// Configure Unistyles before Expo Router pulls in any components using StyleSheet.
import "./src/styles/unistyles";
import "expo-router/entry";
